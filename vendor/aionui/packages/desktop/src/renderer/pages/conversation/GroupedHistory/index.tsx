/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TChatConversation } from '@/common/config/storage';
import { ipcBridge } from '@/common';
import AionModal from '@/renderer/components/base/AionModal';
import DirectorySelectionModal from '@/renderer/components/settings/DirectorySelectionModal';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { useCronJobsMap } from '@/renderer/pages/cron';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { DndContext, DragOverlay, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Button, Checkbox, Dropdown, Empty, Input, Menu, Message, Modal, Tooltip } from '@arco-design/web-react';
import { Delete, EditTwo, FolderOpen, MessageOne, MoreOne, Peoples, Plus, Right } from '@icon-park/react';
import classNames from 'classnames';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';

import WorkspaceCollapse from '../components/WorkspaceCollapse';
import ConversationRow from './ConversationRow';
import DragOverlayContent from './DragOverlayContent';
import SortableConversationRow from './SortableConversationRow';
import { useBatchSelection } from './hooks/useBatchSelection';
import { useConversationActions } from './hooks/useConversationActions';
import { useConversations } from './hooks/useConversations';
import { useDragAndDrop } from './hooks/useDragAndDrop';
import { useExport } from './hooks/useExport';
import type { ConversationRowProps, WorkspaceGroupedHistoryProps } from './types';
import SharedConversationCreateModal from '../components/SharedConversationCreateModal';

const WorkspaceGroupedHistory: React.FC<WorkspaceGroupedHistoryProps> = ({
  onSessionClick,
  collapsed = false,
  tooltipEnabled = false,
  batchMode = false,
  onBatchModeChange,
  afterPinnedContent,
}) => {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sharedCreate, setSharedCreate] = useState<{ projectID: string; projectName: string } | null>(null);
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const isDesktop = isElectronDesktop();
  const { getJobStatus, markAsRead, setActiveConversation } = useCronJobsMap();

  const {
    conversations,
    isConversationGenerating,
    hasCompletionUnread,
    expandedWorkspaces,
    pinnedConversations,
    timelineSections,
    handleToggleWorkspace,
    collapsedSections,
    toggleSection,
  } = useConversations();

  const SectionLabel = useCallback(
    ({ sectionKey, label, trailing }: { sectionKey: string; label: string; trailing?: React.ReactNode }) => {
      const isCollapsed = collapsedSections.has(sectionKey);
      return (
        <div
          className='group/label sider-section-label flex items-center px-12px h-28px select-none sticky top-0 z-10 mt-8px cursor-pointer'
          onClick={() => toggleSection(sectionKey)}
        >
          <span className='text-14px text-t-tertiary sider-section-title group-hover/label:text-t-primary transition-colors font-[500] leading-none'>
            {label}
          </span>
          <span className='ml-2px flex items-center justify-center opacity-0 group-hover/label:opacity-100 transition-opacity text-t-tertiary shrink-0'>
            <Right
              theme='outline'
              size={12}
              className={classNames('transition-transform duration-150', { 'rotate-90': !isCollapsed })}
            />
          </span>
          {trailing && (
            <div className='ml-auto' onClick={(e) => e.stopPropagation()}>
              {trailing}
            </div>
          )}
        </div>
      );
    },
    [collapsedSections, toggleSection]
  );

  // Sync active conversation ref when route changes (for URL navigation)
  // This doesn't trigger state update, avoiding double render
  useEffect(() => {
    if (id) {
      setActiveConversation(id);
    }
  }, [id, setActiveConversation]);

  const {
    selectedConversationIds,
    setSelectedConversationIds,
    selectedCount,
    allSelected,
    toggleSelectedConversation,
    handleToggleSelectAll,
  } = useBatchSelection(batchMode, conversations);

  const {
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
  } = useConversationActions({
    batchMode,
    onSessionClick,
    onBatchModeChange,
    selectedConversationIds,
    setSelectedConversationIds,
    toggleSelectedConversation,
    markAsRead,
  });

  const {
    exportTask,
    exportModalVisible,
    exportTargetPath,
    exportModalLoading,
    showExportDirectorySelector,
    setShowExportDirectorySelector,
    closeExportModal,
    handleSelectExportDirectoryFromModal,
    handleSelectExportFolder,
    // handleExportConversation / handleBatchExport are intentionally not
    // destructured: their UI entries are disabled (kanban #14). The useExport
    // hook and its underlying logic stay intact for a future re-enable.
    handleConfirmExport,
  } = useExport({
    conversations,
    selectedConversationIds,
    setSelectedConversationIds,
    onBatchModeChange,
  });

  const { sensors, activeId, activeConversation, handleDragStart, handleDragEnd, handleDragCancel, isDragEnabled } =
    useDragAndDrop({
      pinnedConversations,
      batchMode,
      collapsed,
    });

  const getConversationRowProps = useCallback(
    (conversation: TChatConversation): ConversationRowProps => {
      const shared = (conversation.extra as { shared?: { conversation_id?: string } } | undefined)?.shared;
      return {
        conversation,
        isGenerating: isConversationGenerating(conversation.id),
        hasCompletionUnread: hasCompletionUnread(conversation.id),
        collapsed,
        tooltipEnabled,
        batchMode: batchMode && !shared,
        checked: selectedConversationIds.has(conversation.id),
        selected: id === conversation.id,
        menuVisible: dropdownVisibleId !== null && dropdownVisibleId === conversation.id,
        onToggleChecked: toggleSelectedConversation,
        onConversationClick: handleConversationClick,
        onOpenMenu: handleOpenMenu,
        onMenuVisibleChange: handleMenuVisibleChange,
        onEditStart: handleEditStart,
        onDelete: shared ? undefined : handleDeleteClick,
        onHide: shared
          ? (target) => {
              const metadata = (target.extra as { shared?: { conversation_id?: string } } | undefined)?.shared;
              if (!metadata?.conversation_id) return;
              void ipcBridge.portal.setSharedConversationHidden
                .invoke({ conversation_id: metadata.conversation_id, hidden: true })
                .then(() => {
                  ipcBridge.conversation.listChanged.emit({
                    conversation_id: target.id,
                    action: 'deleted',
                    source: 'shared-conversation-hidden',
                  });
                  if (id === target.id) void navigate('/');
                  Message.success(
                    t('conversation.history.sharedConversationHidden', { defaultValue: 'Shared conversation hidden' })
                  );
                })
                .catch(() =>
                  Message.error(
                    t('conversation.history.sharedConversationHideFailed', {
                      defaultValue: 'Shared conversation could not be hidden',
                    })
                  )
                );
            }
          : undefined,
        // Export UI entry intentionally disabled (kanban #14): omit onExport so
        // ConversationRow's `{onExport && ...}` guard hides the menu item. The
        // underlying handleExportConversation logic from useExport is kept for a
        // future per-platform re-enable.
        onTogglePin: handleTogglePin,
        onToggleWeixinReminder: handleToggleWeixinReminder,
        getJobStatus,
      };
    },
    [
      collapsed,
      tooltipEnabled,
      batchMode,
      isConversationGenerating,
      hasCompletionUnread,
      selectedConversationIds,
      id,
      dropdownVisibleId,
      toggleSelectedConversation,
      handleConversationClick,
      handleOpenMenu,
      handleMenuVisibleChange,
      handleEditStart,
      handleDeleteClick,
      handleTogglePin,
      handleToggleWeixinReminder,
      navigate,
      t,
      getJobStatus,
    ]
  );

  const renderConversation = (conversation: TChatConversation, dimIcon = false) => {
    const rowProps = getConversationRowProps(conversation);
    return <ConversationRow key={conversation.id} {...rowProps} dimIcon={dimIcon} />;
  };

  // Collect all sortable IDs for the pinned section
  const pinnedIds = useMemo(() => pinnedConversations.map((c) => c.id), [pinnedConversations]);

  // Codex-style split: project folders (workspaces) on top, free conversations below.
  // Projects section: collect all workspace groups across timeline sections, ordered by recency.
  const projectGroups = useMemo(() => {
    const seen = new Set<string>();
    const groups: Array<{
      workspace: string;
      displayName: string;
      conversations: TChatConversation[];
      shared: boolean;
    }> = [];
    for (const section of timelineSections) {
      for (const item of section.items) {
        if (item.type === 'workspace' && item.workspaceGroup && !seen.has(item.workspaceGroup.workspace)) {
          seen.add(item.workspaceGroup.workspace);
          groups.push({
            workspace: item.workspaceGroup.workspace,
            displayName: item.workspaceGroup.display_name,
            conversations: item.workspaceGroup.conversations,
            shared: Boolean(item.workspaceGroup.shared),
          });
        }
      }
    }
    return groups;
  }, [timelineSections]);

  // Conversations section: keep timeline grouping (today/yesterday/...) but only show non-workspace conversations.
  const conversationOnlySections = useMemo(
    () =>
      timelineSections
        .map((section) => ({
          ...section,
          items: section.items.filter((item) => item.type === 'conversation' && item.conversation),
        }))
        .filter((section) => section.items.length > 0),
    [timelineSections]
  );

  if (timelineSections.length === 0 && pinnedConversations.length === 0) {
    return (
      <>
        {afterPinnedContent}
        <div className='py-48px flex-center'>
          <Empty description={t('conversation.history.noHistory')} />
        </div>
      </>
    );
  }

  return (
    <>
      <Modal
        title={t('conversation.history.renameTitle')}
        visible={renameModalVisible}
        onOk={handleRenameConfirm}
        onCancel={handleRenameCancel}
        okText={t('conversation.history.saveName')}
        cancelText={t('conversation.history.cancelEdit')}
        confirmLoading={renameLoading}
        okButtonProps={{ disabled: !renameModalName.trim() }}
        style={{ borderRadius: '12px' }}
        alignCenter
        getPopupContainer={() => document.body}
      >
        <Input
          autoFocus
          value={renameModalName}
          onChange={setRenameModalName}
          onPressEnter={handleRenameConfirm}
          placeholder={t('conversation.history.renamePlaceholder')}
          allowClear
        />
      </Modal>

      <Modal
        visible={exportModalVisible}
        title={t('conversation.history.exportDialogTitle')}
        onCancel={closeExportModal}
        footer={null}
        style={{ borderRadius: '12px' }}
        className='conversation-export-modal'
        alignCenter
        getPopupContainer={() => document.body}
      >
        <div className='py-8px'>
          <div className='text-14px mb-16px text-t-secondary'>
            {exportTask?.mode === 'batch'
              ? t('conversation.history.exportDialogBatchDescription', { count: exportTask.conversation_ids.length })
              : t('conversation.history.exportDialogSingleDescription')}
          </div>

          <div className='mb-16px p-16px rounded-12px bg-fill-1'>
            <div className='text-14px mb-8px text-t-primary'>{t('conversation.history.exportTargetFolder')}</div>
            <div
              className='flex items-center justify-between px-12px py-10px rounded-8px transition-colors'
              style={{
                backgroundColor: 'var(--color-bg-1)',
                border: '1px solid var(--color-border-2)',
                cursor: exportModalLoading ? 'not-allowed' : 'pointer',
                opacity: exportModalLoading ? 0.55 : 1,
              }}
              onClick={() => {
                void handleSelectExportFolder();
              }}
            >
              <span
                className='text-14px overflow-hidden text-ellipsis whitespace-nowrap'
                style={{ color: exportTargetPath ? 'var(--color-text-1)' : 'var(--color-text-3)' }}
              >
                {exportTargetPath || t('conversation.history.exportSelectFolder')}
              </span>
              <FolderOpen theme='outline' size='18' fill='var(--color-text-3)' />
            </div>
          </div>

          <div className='flex items-center gap-8px mb-20px text-14px text-t-secondary'>
            <span>💡</span>
            <span>{t('conversation.history.exportDialogHint')}</span>
          </div>

          <div className='flex gap-12px justify-end'>
            <button
              className='px-24px py-8px rounded-20px text-14px font-medium transition-all'
              style={{
                border: '1px solid var(--color-border-2)',
                backgroundColor: 'var(--color-fill-2)',
                color: 'var(--color-text-1)',
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.backgroundColor = 'var(--color-fill-3)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.backgroundColor = 'var(--color-fill-2)';
              }}
              onClick={closeExportModal}
            >
              {t('common.cancel')}
            </button>
            <button
              className='px-24px py-8px rounded-20px text-14px font-medium transition-all'
              style={{
                border: 'none',
                backgroundColor: exportModalLoading ? 'var(--color-fill-3)' : 'var(--color-text-1)',
                color: 'var(--color-bg-1)',
                cursor: exportModalLoading ? 'not-allowed' : 'pointer',
              }}
              onMouseEnter={(event) => {
                if (!exportModalLoading) {
                  event.currentTarget.style.opacity = '0.85';
                }
              }}
              onMouseLeave={(event) => {
                if (!exportModalLoading) {
                  event.currentTarget.style.opacity = '1';
                }
              }}
              onClick={() => {
                void handleConfirmExport();
              }}
              disabled={exportModalLoading}
            >
              {exportModalLoading ? t('conversation.history.exporting') : t('common.confirm')}
            </button>
          </div>
        </div>
      </Modal>

      <DirectorySelectionModal
        visible={showExportDirectorySelector}
        onConfirm={handleSelectExportDirectoryFromModal}
        onCancel={() => setShowExportDirectorySelector(false)}
      />

      <Modal
        title={t('conversation.history.renameProjectTitle')}
        visible={renameProjectTarget !== null}
        onOk={() => void handleRenameProjectConfirm()}
        onCancel={handleRenameProjectCancel}
        okText={t('conversation.history.renameProject')}
        cancelText={t('common.cancel')}
        confirmLoading={renameProjectLoading}
        okButtonProps={{
          disabled: !renameProjectName.trim() || renameProjectName.trim() === renameProjectTarget?.name,
        }}
        style={{ borderRadius: '12px' }}
        alignCenter
        getPopupContainer={() => document.body}
      >
        <Input
          autoFocus
          value={renameProjectName}
          onChange={setRenameProjectName}
          onPressEnter={() => void handleRenameProjectConfirm()}
          placeholder={t('conversation.history.renameProjectPlaceholder')}
          maxLength={100}
          allowClear
        />
        <div className='mt-16px flex flex-col gap-6px'>
          <Checkbox checked={renameProjectForce} disabled={renameProjectLoading} onChange={setRenameProjectForce}>
            {t('conversation.history.renameProjectForce')}
          </Checkbox>
          {renameProjectForce && (
            <div className='text-12px leading-18px text-danger-6'>
              {t('conversation.history.renameProjectForceRisk')}
            </div>
          )}
        </div>
      </Modal>

      {batchMode && !collapsed && (
        <div className='px-12px pb-8px pt-2px sticky top-0 z-20 bg-[var(--bg-2)]'>
          <div className='rd-8px bg-fill-1 p-10px flex flex-col gap-8px border border-solid border-[rgba(var(--primary-6),0.08)]'>
            <div className='text-12px leading-18px text-t-secondary'>
              {t('conversation.history.selectedCount', { count: selectedCount })}
            </div>
            {/* Batch export UI entry intentionally disabled (kanban #14): the
                button is removed so select-all + delete share the two columns.
                handleBatchExport from useExport is kept for a future re-enable. */}
            <div className='grid grid-cols-2 gap-6px'>
              <Button
                className='!w-full !justify-center !min-w-0 !h-30px !px-8px !text-12px whitespace-nowrap'
                size='mini'
                type='secondary'
                onClick={handleToggleSelectAll}
              >
                {allSelected ? t('common.cancel') : t('conversation.history.selectAll')}
              </Button>
              <Button
                className='!w-full !justify-center !min-w-0 !h-30px !px-8px !text-12px whitespace-nowrap'
                size='mini'
                status='warning'
                onClick={handleBatchDelete}
              >
                {t('conversation.history.batchDelete')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 移除项目确认弹窗 — 使用项目自家 AionModal + 圆角线框按钮（红色危险态） */}
      {sharedCreate && (
        <SharedConversationCreateModal
          visible
          projectID={sharedCreate.projectID}
          projectName={sharedCreate.projectName}
          onCancel={() => setSharedCreate(null)}
          onCreated={(id) => {
            setSharedCreate(null);
            void navigate(`/conversation/${id}`);
          }}
        />
      )}

      <AionModal
        visible={removeProjectTarget !== null}
        style={{ width: '400px' }}
        header={{
          title: t('conversation.history.removeProjectTitle'),
          showClose: true,
          style: { borderBottom: 'none' },
        }}
        onCancel={handleRemoveProjectCancel}
        footer={
          <div className='flex justify-end gap-12px pt-16px'>
            <button
              type='button'
              className='px-24px py-8px rounded-20px text-14px font-medium transition-all'
              style={{
                border: '1px solid var(--color-border-2)',
                backgroundColor: 'var(--color-fill-2)',
                color: 'var(--color-text-1)',
                cursor: removeProjectLoading ? 'not-allowed' : 'pointer',
                opacity: removeProjectLoading ? 0.55 : 1,
              }}
              onMouseEnter={(event) => {
                if (!removeProjectLoading) event.currentTarget.style.backgroundColor = 'var(--color-fill-3)';
              }}
              onMouseLeave={(event) => {
                if (!removeProjectLoading) event.currentTarget.style.backgroundColor = 'var(--color-fill-2)';
              }}
              onClick={handleRemoveProjectCancel}
              disabled={removeProjectLoading}
            >
              {t('conversation.history.cancelDelete')}
            </button>
            <button
              type='button'
              className='px-24px py-8px rounded-20px text-14px font-medium transition-all'
              style={{
                border: '1px solid rgb(var(--danger-6))',
                backgroundColor: 'transparent',
                color: 'rgb(var(--danger-6))',
                cursor: removeProjectLoading ? 'not-allowed' : 'pointer',
                opacity: removeProjectLoading ? 0.55 : 1,
              }}
              onMouseEnter={(event) => {
                if (!removeProjectLoading) {
                  event.currentTarget.style.backgroundColor = 'rgba(var(--danger-6), 0.08)';
                }
              }}
              onMouseLeave={(event) => {
                if (!removeProjectLoading) event.currentTarget.style.backgroundColor = 'transparent';
              }}
              onClick={() => void handleRemoveProjectConfirm()}
              disabled={removeProjectLoading}
            >
              {removeProjectLoading ? t('conversation.history.deleting') : t('conversation.history.confirmDelete')}
            </button>
          </div>
        }
      >
        <div className='text-14px leading-22px text-t-secondary'>
          {t('conversation.history.removeProjectConfirm', {
            name: removeProjectTarget?.name ?? '',
            count: removeProjectTarget?.conversations.length ?? 0,
          })}
        </div>
      </AionModal>

      <div>
        {/* L1: Pinned section */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          {pinnedConversations.length > 0 && (
            <div className='min-w-0'>
              {!collapsed && <SectionLabel sectionKey='pinned' label={t('conversation.history.pinnedSection')} />}
              {!collapsedSections.has('pinned') && (
                <SortableContext items={pinnedIds} strategy={verticalListSortingStrategy}>
                  <div className='min-w-0'>
                    {pinnedConversations.map((conversation) => {
                      const props = getConversationRowProps(conversation);
                      return isDragEnabled ? (
                        <SortableConversationRow key={conversation.id} {...props} />
                      ) : (
                        <ConversationRow key={conversation.id} {...props} />
                      );
                    })}
                  </div>
                </SortableContext>
              )}
            </div>
          )}

          <DragOverlay dropAnimation={null}>
            {activeId && activeConversation ? <DragOverlayContent conversation={activeConversation} /> : null}
          </DragOverlay>
        </DndContext>

        {/* Slot 由父级（Sider）填入：例如 Team / CronJob sections，位于「置顶」之后、「项目」之前 */}
        {afterPinnedContent}

        {/* L1: Projects section — workspace folders, peer to conversations */}
        {projectGroups.length > 0 && (
          <div className='min-w-0'>
            {!collapsed && <SectionLabel sectionKey='projects' label={t('conversation.history.projectsSection')} />}
            {!collapsedSections.has('projects') &&
              projectGroups.map((group) => {
                const projectMenu = group.shared ? (
                  <Menu
                    onClickMenuItem={(key) => {
                      const projectID = group.workspace.replace(/^shared:\/\//, '');
                      if (key === 'private') {
                        void navigate('/guid', { state: { workspace: group.workspace } });
                        return;
                      }
                      if (key !== 'hide') return;
                      void ipcBridge.portal.setSharedProjectHidden
                        .invoke({ project_id: projectID, hidden: true })
                        .then(() => {
                          ipcBridge.conversation.listChanged.emit({
                            conversation_id: group.conversations[0]?.id ?? `shared-project:${projectID}`,
                            action: 'deleted',
                            source: 'shared-project-hidden',
                          });
                          if (group.conversations.some((conversation) => conversation.id === id)) void navigate('/');
                          Message.success(
                            t('conversation.history.sharedProjectHidden', { defaultValue: 'Shared project hidden' })
                          );
                        })
                        .catch(() =>
                          Message.error(
                            t('conversation.history.sharedProjectHideFailed', {
                              defaultValue: 'Shared project could not be hidden',
                            })
                          )
                        );
                    }}
                  >
                    <Menu.Item key='private'>
                      <span className='flex items-center gap-8px'>
                        <MessageOne theme='outline' size='14' />
                        {t('conversation.history.newPrivateSharedConversation', {
                          defaultValue: 'New private conversation',
                        })}
                      </span>
                    </Menu.Item>
                    <Menu.Item key='hide'>
                      <span className='flex items-center gap-8px'>
                        <Delete theme='outline' size='14' />
                        {t('conversation.history.hideSharedProject', { defaultValue: 'Hide shared project' })}
                      </span>
                    </Menu.Item>
                  </Menu>
                ) : (
                  <Menu
                    onClickMenuItem={(key) => {
                      if (key === 'rename') {
                        handleRenameProject(group.displayName, group.workspace, group.conversations);
                      } else if (key === 'remove') {
                        handleRemoveProject(group.displayName, group.conversations);
                      }
                    }}
                  >
                    {!isDesktop && (
                      <Menu.Item key='rename'>
                        <span className='flex items-center gap-8px'>
                          <EditTwo theme='outline' size='14' />
                          {t('conversation.history.renameProject')}
                        </span>
                      </Menu.Item>
                    )}
                    <Menu.Item key='remove' className='!text-[rgb(var(--danger-6))]'>
                      <span className='flex items-center gap-8px'>
                        <Delete theme='outline' size='14' />
                        {t('conversation.history.removeProject')}
                      </span>
                    </Menu.Item>
                  </Menu>
                );
                return (
                  <div key={group.workspace} className='min-w-0'>
                    <WorkspaceCollapse
                      expanded={expandedWorkspaces.includes(group.workspace)}
                      onToggle={() => handleToggleWorkspace(group.workspace)}
                      siderCollapsed={collapsed}
                      stickyHeader
                      stickyTop={28}
                      header={
                        <span className='text-14px font-[500] truncate flex-1 text-t-primary min-w-0 flex items-center gap-6px'>
                          {group.shared && <Peoples theme='outline' size='14' className='shrink-0' />}
                          {group.displayName}
                        </span>
                      }
                      trailing={
                        <span className='flex items-center gap-6px'>
                          <Tooltip content={t('conversation.history.newConversationInProject')} position='top'>
                            <span
                              role='button'
                              tabIndex={0}
                              aria-label={t('conversation.history.newConversationInProject')}
                              className={classNames(
                                'flex-center cursor-pointer transition-colors text-t-secondary hover:text-t-primary size-20px rd-4px sider-action-btn',
                                isMobile ? 'flex' : 'hidden group-hover:flex'
                              )}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (group.shared)
                                  setSharedCreate({
                                    projectID: group.workspace.replace(/^shared:\/\//, ''),
                                    projectName: group.displayName,
                                  });
                                else void navigate('/guid', { state: { workspace: group.workspace } });
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  if (group.shared)
                                    setSharedCreate({
                                      projectID: group.workspace.replace(/^shared:\/\//, ''),
                                      projectName: group.displayName,
                                    });
                                  else void navigate('/guid', { state: { workspace: group.workspace } });
                                }
                              }}
                            >
                              <Plus theme='outline' size='14' fill='currentColor' className='block leading-none' />
                            </span>
                          </Tooltip>
                          {projectMenu && (
                            <Dropdown
                              droplist={projectMenu}
                              trigger='click'
                              position='br'
                              getPopupContainer={() => document.body}
                              unmountOnExit={false}
                            >
                              <span
                                aria-label='Project actions'
                                className={classNames(
                                  'flex-center cursor-pointer transition-colors text-t-secondary hover:text-t-primary size-20px rd-4px sider-action-btn',
                                  isMobile ? 'flex' : 'hidden group-hover:flex'
                                )}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <MoreOne theme='outline' size='14' fill='currentColor' className='block leading-none' />
                              </span>
                            </Dropdown>
                          )}
                        </span>
                      }
                    >
                      <div className={classNames('flex flex-col min-w-0', { 'mt-1px': !collapsed })}>
                        {group.conversations.map((conversation) => renderConversation(conversation, true))}
                      </div>
                    </WorkspaceCollapse>
                  </div>
                );
              })}
          </div>
        )}

        {/* L1: Conversations section — peer to projects, internally split by timeline */}
        {conversationOnlySections.length > 0 && (
          <div className='min-w-0'>
            {!collapsed && (
              <SectionLabel sectionKey='conversations' label={t('conversation.history.conversationsSection')} />
            )}
            {!collapsedSections.has('conversations') &&
              conversationOnlySections.map((section) => (
                <div key={section.timeline} className='min-w-0'>
                  {!collapsed && conversationOnlySections.length > 1 && (
                    <div className='flex items-center px-16px h-24px select-none'>
                      <span className='text-12px text-t-secondary font-[500] leading-none'>{section.timeline}</span>
                    </div>
                  )}
                  {section.items.map((item) =>
                    item.type === 'conversation' && item.conversation ? renderConversation(item.conversation) : null
                  )}
                </div>
              ))}
          </div>
        )}
      </div>
    </>
  );
};

export default WorkspaceGroupedHistory;
