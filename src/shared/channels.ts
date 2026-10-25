import { z } from 'zod';

export const channelProvider = z.enum(['slack', 'telegram']);
export type ChannelProvider = z.infer<typeof channelProvider>;
const id = z.string().trim().min(1).max(100);
export const channelInput = z
  .object({
    enabled: z.boolean(),
    dotId: z.string().max(100),
    workspaceId: z.string().trim().max(100).default(''),
    ownerUserIds: z.array(id).max(100),
    chatId: z
      .string()
      .trim()
      .max(100)
      .refine((value) => value === '' || /^-?\d+$/.test(value))
      .default(''),
    botToken: z.string().trim().min(1).max(512).nullable().optional(),
    appToken: z.string().trim().min(1).max(512).nullable().optional(),
  })
  .strict();
export type ChannelInput = z.infer<typeof channelInput>;
export interface ChannelSettings {
  provider: ChannelProvider;
  enabled: boolean;
  dotId: string;
  workspaceId: string;
  ownerUserIds: string[];
  chatId: string;
  revision: number;
  botTokenSet: boolean;
  appTokenSet: boolean;
  status: 'disabled' | 'connecting' | 'connected' | 'failed';
  failure: string | null;
  ignored: number;
}
