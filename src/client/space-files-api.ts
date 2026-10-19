import { api, authHeaders, ApiError } from './api';
import type { SpaceFile } from '../shared/space-files';

/** Bytes as base64, in slices so a large file does not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function uploadSpaceFile(
  spaceId: string,
  file: File,
  parentId: string | null = null,
): Promise<SpaceFile> {
  return api<SpaceFile>(`/spaces/${spaceId}/files`, 'POST', {
    name: file.name,
    contentBase64: toBase64(new Uint8Array(await file.arrayBuffer())),
    parentId,
  });
}

/** A file's bytes. The request carries the owner token, which a plain link could not. */
export async function fetchSpaceFile(
  spaceId: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(
    `/api/spaces/${spaceId}/files/${fileId}/content`,
    {
      headers: authHeaders(),
      signal,
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new ApiError(
      body.error ?? `Could not load the file (${response.status}).`,
      response.status,
    );
  }
  return response.blob();
}

/** Saves bytes as a file through the browser's download. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The link to a file inside the app: opens the viewer, in this tab or a new one. */
export const fileHash = (spaceId: string, fileId: string) =>
  `#/spaces/${spaceId}/files/${fileId}`;
