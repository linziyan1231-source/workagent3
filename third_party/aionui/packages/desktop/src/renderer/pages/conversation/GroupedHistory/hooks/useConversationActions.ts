/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { TChatConversation } from '@/common/config/storage';
import { replaceRecentWorkspace } from '@/renderer/components/workspace';
import { refreshConversationCache } from '@/renderer/pages/conversation/utils/conversationCache';
import { emitter } from '@/renderer/utils/emitter';
import { blockMobileInputFocus, blurActiveElement } from '@/renderer/utils/ui/focus';
import { replaceWorkspaceTime } from '@/renderer/utils/workspace/workspaceHistory';
import { Message, Modal } from '@arco-design/web-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';

import { isConversationPinned } from '../utils/groupingHelpers';
import { replaceExpandedWorkspacePath } from './useWorkspaceExpansionState';

type UseConversationActionsParams = {
  batchMode: boolean;
  onSessionClick?: () => void;
  onBatchModeChange?: (value: boolean) => void;
  selectedConversationIds: Set<string>;
  setSelectedConversationIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  toggleSelectedConversation: (conversation: TChatConversation) => void;
  markAsRead: (conversation_id: string) => void;
};

export const useConversationActions = ({
  batchMode,
  onSessionClick,
  onBatchModeChange,
  selectedConversationIds,
  setSelectedConversationIds,
  toggleSelectedConversation,
  markAsRead,
}: UseConversationActionsParams) => {
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [renameModalName, setRenameModalName] = useState<string>('');
  const [renameModalId, setRenameModalId] = useState<string | null>(null);
  const [renameLoading, setRenameLoading] = useState(false);
  const [dropdownVisibleId, setDropdownVisibleId] = useState<string | null>(null);
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();

  // Close dropdown when entering batch mode
  useEffect(() => {
    if (batchMode) {
      setDropdownVisibleId(null);
    }
  }, [batchMode]);

  const handleConversationClick = useCallback(
    (conversation: TChatConversation) => {
      setDropdownVisibleId(null);
      if (batchMode) {
        toggleSelectedConversation(conversation);
        return;
      }
      blockMobileInputFocus();
      blurActiveElement();

      markAsRead(conversation.id);

      void navigate(`/conversation/${conversation.id}`);
      if (onSessionClick) {
        onSessionClick();
      }
    },
    [batchMode, toggleSelectedConversation, markAsRead, navigate, onSessionClick]
  );

  const removeConversation = useCallback(
    async (conversation_id: string) => {
      const success = await ipcBridge.conversation.remove.invoke({ id: conversation_id });
      if (!success) {
        return false;
      }

      emitter.emit('conversation.deleted', conversation_id);
      if (id === conversation_id) {
        void navigate('/');
      }
      return true;
    },
    [id, navigate]
  );

  const handleDeleteClick = useCallback(
    (conversation_id: string) => {
      Modal.confirm({
        title: t('conversation.history.deleteTitle'),
        content: t('conversation.history.deleteConfirm'),
        okText: t('conversation.history.confirmDelete'),
        cancelText: t('conversation.history.cancelDelete'),
        okButtonProps: { status: 'warning' },
        onOk: async () => {
          try {
            const success = await removeConversation(conversation_id);
            if (success) {
              emitter.emit('chat.history.refresh');
              Message.success(t('conversation.history.deleteSuccess'));
            } else {
              Message.error(t('conversation.history.deleteFailed'));
            }
          } catch (error) {
            console.error('Failed to remove conversation:', error);
            Message.error(t('conversation.history.deleteFailed'));
          }
        },
        style: { borderRadius: '12px' },
        alignCenter: true,
        getPopupContainer: () => document.body,
      });
    },
    [removeConversation, t]
  );

  const handleBatchDelete = useCallback(() => {
    if (selectedConversationIds.size === 0) {
      Message.warning(t('conversation.history.batchNoSelection'));
      return;
    }

    Modal.confirm({
      title: t('conversation.history.batchDelete'),
      content: t('conversation.history.batchDeleteConfirm', { count: selectedConversationIds.size }),
      okText: t('conversation.history.confirmDelete'),
      cancelText: t('conversation.history.cancelDelete'),
      okButtonProps: { status: 'warning' },
      onOk: async () => {
        const selectedIds = Array.from(selectedConversationIds);
        try {
          const results = await Promise.all(selectedIds.map((conversation_id) => removeConversation(conversation_id)));
          const successCount = results.filter(Boolean).length;
          emitter.emit('chat.history.refresh');
          if (successCount > 0) {
            Message.success(t('conversation.history.batchDeleteSuccess', { count: successCount }));
          } else {
            Message.error(t('conversation.history.deleteFailed'));
          }
        } catch (error) {
          console.error('Failed to batch delete conversations:', error);
          Message.error(t('conversation.history.deleteFailed'));
        } finally {
          setSelectedConversationIds(new Set());
          onBatchModeChange?.(false);
        }
      },
      style: { borderRadius: '12px' },
      alignCenter: true,
      getPopupContainer: () => document.body,
    });
  }, [onBatchModeChange, removeConversation, selectedConversationIds, t, setSelectedConversationIds]);

  const handleEditStart = useCallback((conversation: TChatConversation) => {
    setRenameModalId(conversation.id);
    setRenameModalName(conversation.name);
    setRenameModalVisible(true);
  }, []);

  const handleRenameConfirm = useCallback(async () => {
    if (!renameModalId || !renameModalName.trim()) return;

    setRenameLoading(true);
    try {
      const success = await ipcBridge.conversation.update.invoke({
        id: renameModalId,
        updates: { name: renameModalName.trim() },
      });

      if (success) {
        await refreshConversationCache(renameModalId);
        emitter.emit('chat.history.refresh');
        setRenameModalVisible(false);
        setRenameModalId(null);
        setRenameModalName('');
        Message.success(t('conversation.history.renameSuccess'));
      } else {
        Message.error(t('conversation.history.renameFailed'));
      }
    } catch (error) {
      console.error('Failed to update conversation name:', error);
      Message.error(t('conversation.history.renameFailed'));
    } finally {
      setRenameLoading(false);
    }
  }, [renameModalId, renameModalName, t]);

  const handleRenameCancel = useCallback(() => {
    setRenameModalVisible(false);
    setRenameModalId(null);
    setRenameModalName('');
  }, []);

  const handleTogglePin = useCallback(
    async (conversation: TChatConversation) => {
      const pinned = isConversationPinned(conversation);

      try {
        const success = await ipcBridge.conversation.update.invoke({
          id: conversation.id,
          updates: {
            extra: {
              pinned: !pinned,
              pinned_at: pinned ? undefined : Date.now(),
            } as Partial<TChatConversation['extra']>,
          } as Partial<TChatConversation>,
          merge_extra: true,
        });

        if (success) {
          emitter.emit('chat.history.refresh');
        } else {
          Message.error(t('conversation.history.pinFailed'));
        }
      } catch (error) {
        console.error('Failed to toggle pin conversation:', error);
        Message.error(t('conversation.history.pinFailed'));
      }
    },
    [t]
  );

  const handleToggleWeixinReminder = useCallback(
    async (conversation: TChatConversation) => {
      const enabled = (conversation.extra as Record<string, unknown> | undefined)?.weixinReminderEnabled === true;
      try {
        const success = await ipcBridge.conversation.update.invoke({
          id: conversation.id,
          updates: {
            extra: {
              weixinReminderEnabled: !enabled,
            } as Partial<TChatConversation['extra']>,
          } as Partial<TChatConversation>,
          merge_extra: true,
        });
        if (!success) {
          Message.error(t('conversation.history.weixinReminderUpdateFailed'));
          return;
        }
        await refreshConversationCache(conversation.id);
        emitter.emit('chat.history.refresh');
        setDropdownVisibleId(null);
        Message.success(
          t(enabled ? 'conversation.history.weixinReminderDisabled' : 'conversation.history.weixinReminderEnabled')
        );
      } catch (error) {
        console.error('Failed to toggle WeChat reminder:', error);
        Message.error(t('conversation.history.weixinReminderUpdateFailed'));
      }
    },
    [t]
  );

  const handleMenuVisibleChange = useCallback((conversation_id: string, visible: boolean) => {
    setDropdownVisibleId(visible ? conversation_id : null);
  }, []);

  const handleOpenMenu = useCallback((conversation: TChatConversation) => {
    setDropdownVisibleId(conversation.id);
  }, []);

  /**
   * Remove project state — rendered via AionModal in the GroupedHistory component.
   * Uses project's design system: AionModal component with danger-styled action button.
   */
  const [removeProjectTarget, setRemoveProjectTarget] = useState<{
    name: string;
    conversations: TChatConversation[];
  } | null>(null);
  const [removeProjectLoading, setRemoveProjectLoading] = useState(false);

  const [renameProjectTarget, setRenameProjectTarget] = useState<{
    name: string;
    workspace: string;
    conversations: TChatConversation[];
  } | null>(null);
  const [renameProjectName, setRenameProjectName] = useState('');
  const [renameProjectLoading, setRenameProjectLoading] = useState(false);
  const [renameProjectForce, setRenameProjectForce] = useState(false);

  const handleRenameProject = useCallback(
    (projectName: string, workspace: string, conversations: TChatConversation[]) => {
      setRenameProjectTarget({ name: projectName, workspace, conversations });
      setRenameProjectName(projectName);
      setRenameProjectForce(false);
    },
    []
  );

  const handleRenameProjectCancel = useCallback(() => {
    if (renameProjectLoading) return;
    setRenameProjectTarget(null);
    setRenameProjectName('');
    setRenameProjectForce(false);
  }, [renameProjectLoading]);

  const performProjectRename = useCallback(
    async (force: boolean) => {
      const nextName = renameProjectName.trim();
      if (!renameProjectTarget || !nextName || nextName === renameProjectTarget.name) return;
      setRenameProjectLoading(true);
      try {
        const result = await ipcBridge.portal.renameProject.invoke({
          path: renameProjectTarget.workspace,
          name: nextName,
          force,
        });
        replaceRecentWorkspace(result.old_path, result.new_path);
        replaceWorkspaceTime(result.old_path, result.new_path);
        replaceExpandedWorkspacePath(result.old_path, result.new_path);
        await Promise.all(
          renameProjectTarget.conversations.map((conversation) => refreshConversationCache(conversation.id))
        );
        emitter.emit('chat.history.refresh');
        setRenameProjectTarget(null);
        setRenameProjectName('');
        setRenameProjectForce(false);
        Message.success(t('conversation.history.renameProjectSuccess', { name: nextName }));
      } catch (error) {
        console.error('Failed to rename project:', error);
        const key = isBackendHttpError(error)
          ? error.code === 'PROJECT_EXISTS'
            ? 'conversation.history.renameProjectExists'
            : error.code === 'PROJECT_IN_USE'
              ? 'conversation.history.renameProjectInUse'
              : error.code === 'PROJECT_FORCE_STOP_FAILED'
                ? 'conversation.history.renameProjectForceFailed'
                : error.code === 'INVALID_PROJECT_NAME'
                  ? 'conversation.history.renameProjectInvalid'
                  : 'conversation.history.renameProjectFailed'
          : 'conversation.history.renameProjectFailed';
        Message.error(t(key));
      } finally {
        setRenameProjectLoading(false);
      }
    },
    [renameProjectName, renameProjectTarget, t]
  );

  const handleRenameProjectConfirm = useCallback(async () => {
    if (!renameProjectForce) {
      await performProjectRename(false);
      return;
    }
    Modal.confirm({
      title: t('conversation.history.renameProjectForceConfirmTitle'),
      content: t('conversation.history.renameProjectForceConfirmContent'),
      okText: t('conversation.history.renameProjectForceConfirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { status: 'danger' },
      onOk: () => performProjectRename(true),
    });
  }, [performProjectRename, renameProjectForce, t]);

  const handleRemoveProject = useCallback((projectName: string, conversations: TChatConversation[]) => {
    if (conversations.length === 0) return;
    setRemoveProjectTarget({ name: projectName, conversations });
  }, []);

  const handleRemoveProjectCancel = useCallback(() => {
    if (removeProjectLoading) return;
    setRemoveProjectTarget(null);
  }, [removeProjectLoading]);

  const handleRemoveProjectConfirm = useCallback(async () => {
    if (!removeProjectTarget) return;
    setRemoveProjectLoading(true);
    try {
      const results = await Promise.all(removeProjectTarget.conversations.map((c) => removeConversation(c.id)));
      const successCount = results.filter(Boolean).length;
      emitter.emit('chat.history.refresh');
      if (successCount > 0) {
        Message.success(
          t('conversation.history.batchDeleteSuccess', {
            count: successCount,
          })
        );
      } else {
        Message.error(t('conversation.history.deleteFailed'));
      }
      setRemoveProjectTarget(null);
    } catch (error) {
      console.error('Failed to remove project:', error);
      Message.error(t('conversation.history.deleteFailed'));
    } finally {
      setRemoveProjectLoading(false);
    }
  }, [removeProjectTarget, removeConversation, t]);

  return {
    renameModalVisible,
    renameModalName,
    setRenameModalName,
    renameLoading,
    dropdownVisibleId,
    handleConversationClick,
    handleDeleteClick,
    handleBatchDelete,
    handleEditStart,
    handleRenameConfirm,
    handleRenameCancel,
    handleTogglePin,
    handleToggleWeixinReminder,
    handleMenuVisibleChange,
    handleOpenMenu,
    handleRemoveProject,
    removeProjectTarget,
    removeProjectLoading,
    handleRemoveProjectCancel,
    handleRemoveProjectConfirm,
    renameProjectTarget,
    renameProjectName,
    setRenameProjectName,
    renameProjectForce,
    setRenameProjectForce,
    renameProjectLoading,
    handleRenameProject,
    handleRenameProjectCancel,
    handleRenameProjectConfirm,
  };
};
