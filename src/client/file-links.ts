/** The link to a file inside the app: opens the viewer, in this tab or a new one. */
export const fileHash = (spaceId: string, fileId: string) =>
  `#/spaces/${spaceId}/files/${fileId}`;
