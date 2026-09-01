import type { ComponentType, ReactNode } from "react";
import type { PreviewContentType } from "@/common/types/office/preview";

export type PreviewMetadata = {
  language?: string;
  title?: string;
  diff?: string;
  file_name?: string;
  file_path?: string;
  workspace?: string;
  editable?: boolean;
  truncated?: boolean;
  targetLine?: number;
  targetColumn?: number;
  missingFile?: boolean;
};

export type PreviewTab = {
  id: string;
  content: string;
  content_type: PreviewContentType;
  metadata?: PreviewMetadata;
  title: string;
  isDirty?: boolean;
  originalContent?: string;
};

export type PreviewContextValue = {
  isOpen: boolean;
  tabs: PreviewTab[];
  activeTabId: string | null;
  activeTab: PreviewTab | null;
  openPreview: (
    content: string,
    type: PreviewContentType,
    metadata?: PreviewMetadata,
    options?: { replace?: boolean },
  ) => void;
  closePreview: () => void;
  closeTab: (tabId: string) => void;
  switchTab: (tabId: string) => void;
  updateContent: (content: string) => void;
  saveContent: (tabId?: string) => Promise<boolean>;
  findPreviewTab: (
    type: PreviewContentType,
    content?: string,
    metadata?: PreviewMetadata,
  ) => PreviewTab | null;
  closePreviewByIdentity: (
    type: PreviewContentType,
    content?: string,
    metadata?: PreviewMetadata,
  ) => void;
  addToSendBox: (text: string) => void;
  setSendBoxHandler: (handler: ((text: string) => void) | null) => void;
  domSnippets: Array<{ id: string; tag: string; html: string }>;
  addDomSnippet: (tag: string, html: string) => void;
  removeDomSnippet: (id: string) => void;
  clearDomSnippets: () => void;
};

export const PreviewProvider: ComponentType<{ children: ReactNode }>;
export const PreviewPanel: ComponentType;
export function usePreviewContext(): PreviewContextValue;
export function useOptionalPreviewContext(): PreviewContextValue | null;
export function useLocalFilePreview(
  workspace?: string,
): (
  path: string,
  reference?: { line?: number; column?: number },
) => Promise<void>;
