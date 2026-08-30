/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

const WORKSPACE_UPDATE_TIME_KEY = 'aionui_workspace_update_time';

/**
 * 获取 workspace 的最后更新时间
 */
export const getWorkspaceUpdateTime = (workspace: string): number => {
  try {
    const stored = localStorage.getItem(WORKSPACE_UPDATE_TIME_KEY);
    if (stored) {
      const times = JSON.parse(stored) as Record<string, number>;
      return times[workspace] || 0;
    }
  } catch {
    // Ignore parsing errors and fall back to default
  }
  return 0;
};

/**
 * 更新 workspace 的最后更新时间
 * 在创建新会话时调用此函数
 */
export const updateWorkspaceTime = (workspace: string): void => {
  try {
    const stored = localStorage.getItem(WORKSPACE_UPDATE_TIME_KEY);
    const times = stored ? JSON.parse(stored) : {};
    times[workspace] = Date.now();
    localStorage.setItem(WORKSPACE_UPDATE_TIME_KEY, JSON.stringify(times));
  } catch (error) {
    console.error('[WorkspaceHistory] Failed to update workspace time:', error);
  }
};

export const replaceWorkspaceTime = (oldWorkspace: string, newWorkspace: string): void => {
  try {
    const stored = localStorage.getItem(WORKSPACE_UPDATE_TIME_KEY);
    if (!stored) return;
    const times = JSON.parse(stored) as Record<string, number>;
    if (!(oldWorkspace in times)) return;
    times[newWorkspace] = times[oldWorkspace];
    delete times[oldWorkspace];
    localStorage.setItem(WORKSPACE_UPDATE_TIME_KEY, JSON.stringify(times));
  } catch (error) {
    console.error('[WorkspaceHistory] Failed to replace workspace time:', error);
  }
};
