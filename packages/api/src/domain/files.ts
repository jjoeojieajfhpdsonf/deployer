import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  decodeFiles, commitFiles, readFiles, listFiles, archiveZip, headCommit, validateFilePath,
  type FileInput, type RepoFile,
} from '../lib/local-repo.js'
import { pushRepo } from '../lib/git.js'
import { badRequest } from '../lib/errors.js'
import { localRepoPath } from '../deploy/sources/files.js'
import { repoUrlPolicy } from './git-policy.js'
import { findProject, createProject } from './projects.js'
import { audit } from './audit.js'
import { rm } from 'node:fs/promises'
import type { CreateProjectInput } from '@deployer/shared'

/**
 * Dateien eines Chat-Projekts (Quelle files, M3). Gemeinsame Schicht für
 * MCP und REST.
 */

type Project = typeof schema.projects.$inferSelect

function repoOf(project: Project): string {
  if (project.sourceType !== 'files') throw badRequest('Dateien gibt es nur bei Projekten mit Quelle files')
  return project.localRepoPath ?? localRepoPath(project.slug)
}

/**
 * Legt ein Chat-Projekt an: Dateien zuerst prüfen, dann Projekt und erster
 * Commit. Scheitert der Commit, wird das Projekt wieder entfernt – es bleibt
 * kein Projekt ohne Dateien zurück.
 */
export async function createFilesProject(input: CreateProjectInput, actor: string): Promise<Project> {
  decodeFiles(input.files ?? []) // wirft vor dem Anlegen bei ungültigen Pfaden oder zu viel Inhalt
  const project = await createProject(input, actor)
  try {
    await initProjectFiles(project, input.files ?? [], actor)
  } catch (err) {
    await rm(localRepoPath(project.slug), { recursive: true, force: true })
    await db.delete(schema.projects).where(eq(schema.projects.id, project.id))
    throw err
  }
  return findProject(project.id)
}

/** Erster Commit beim Anlegen. */
export async function initProjectFiles(project: Project, files: FileInput[], actor: string): Promise<string> {
  const dir = localRepoPath(project.slug)
  const { commit } = await commitFiles(dir, { write: decodeFiles(files), message: 'Erste Fassung aus dem Chat' })
  await db
    .update(schema.projects)
    .set({ localRepoPath: dir, lastChangeAt: new Date(), expiryWarnedAt: null })
    .where(eq(schema.projects.id, project.id))
  await audit({
    actor, action: 'files.init', targetType: 'project', targetId: project.id,
    params: { files: files.map((f) => f.path), commit }, result: 'ok',
  })
  return commit
}

/** Geänderte und gelöschte Dateien committen. Setzt die Ablauffrist zurück. */
export async function updateProjectFiles(
  idOrSlug: string,
  o: { files?: FileInput[]; delete?: string[]; message: string },
  actor: string,
): Promise<{ commit: string; changed: boolean; project: Project }> {
  const project = await findProject(idOrSlug)
  const dir = repoOf(project)
  const write = decodeFiles(o.files ?? [])
  const remove = (o.delete ?? []).map(validateFilePath)
  if (write.length === 0 && remove.length === 0) throw badRequest('Keine Dateien zum Ändern oder Löschen')
  const r = await commitFiles(dir, { write, remove, message: o.message })
  if (r.changed) {
    await db
      .update(schema.projects)
      .set({ lastChangeAt: new Date(), expiryWarnedAt: null, updatedAt: new Date() })
      .where(eq(schema.projects.id, project.id))
  }
  await audit({
    actor, action: 'files.update', targetType: 'project', targetId: project.id,
    // Pfade und Grössen, nie Inhalte.
    params: { write: write.map((f) => ({ path: f.path, size: f.data.length })), delete: remove, commit: r.commit, message: o.message },
    result: 'ok',
  })
  return { ...r, project }
}

export async function readProjectFiles(idOrSlug: string, paths?: string[]) {
  const project = await findProject(idOrSlug)
  const dir = repoOf(project)
  return { commit: await headCommit(dir), files: await readFiles(dir, paths) }
}

export async function listProjectFiles(idOrSlug: string): Promise<{ commit: string | null; files: RepoFile[] }> {
  const project = await findProject(idOrSlug)
  const dir = repoOf(project)
  const commit = await headCommit(dir)
  return { commit, files: commit ? await listFiles(dir) : [] }
}

export async function exportProjectZip(idOrSlug: string, actor: string): Promise<{ zip: Buffer; commit: string | null }> {
  const project = await findProject(idOrSlug)
  const dir = repoOf(project)
  const zip = await archiveZip(dir)
  await audit({ actor, action: 'files.export', targetType: 'project', targetId: project.id, params: { format: 'zip', size: zip.length }, result: 'ok' })
  return { zip, commit: await headCommit(dir) }
}

/** Auf ein entferntes Repo schieben. Das Token wird nie geloggt. */
export async function pushProjectRepo(
  idOrSlug: string,
  o: { url: string; branch?: string; token?: string },
  actor: string,
): Promise<{ displayUrl: string; commit: string | null }> {
  const project = await findProject(idOrSlug)
  const dir = repoOf(project)
  const r = await pushRepo({ dir, url: o.url, branch: o.branch ?? 'main', token: o.token, policy: await repoUrlPolicy() })
  await audit({
    actor, action: 'files.export', targetType: 'project', targetId: project.id,
    params: { format: 'push', url: r.displayUrl, branch: o.branch ?? 'main', withToken: Boolean(o.token) },
    result: 'ok',
  })
  return { displayUrl: r.displayUrl, commit: await headCommit(dir) }
}
