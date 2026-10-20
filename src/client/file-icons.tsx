import {
  File,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  type LucideProps,
} from 'lucide-react';
import type { FileKind } from '../shared/space-files';

/** The icon for a file by what it is, so a table, an image and a document read differently at a glance. */
export function FileKindIcon({
  kind,
  ...props
}: { kind: FileKind } & LucideProps) {
  const ICONS: Record<FileKind, typeof File> = {
    csv: FileSpreadsheet,
    image: FileImage,
    json: FileJson,
    html: FileCode,
    markdown: FileText,
    text: FileText,
    pdf: FileText,
    download: File,
  };
  const Icon = ICONS[kind];
  return <Icon aria-hidden {...props} />;
}
