import {
  File,
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
  const Icon =
    kind === 'csv'
      ? FileSpreadsheet
      : kind === 'image'
        ? FileImage
        : kind === 'json'
          ? FileJson
          : kind === 'markdown' || kind === 'text' || kind === 'pdf'
            ? FileText
            : File;
  return <Icon aria-hidden {...props} />;
}
