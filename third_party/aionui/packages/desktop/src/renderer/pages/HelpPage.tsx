/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Typography } from '@arco-design/web-react';
import { ArrowLeft, Down } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import brandLogo from '@/renderer/assets/logos/brand/app.png';
import guideHtml from './help/guide.zh-CN.html?raw';
import styles from './HelpPage.module.css';

const guideSections = [
  ['quick-start', '0. 快速开始'],
  ['concepts', '1. 基本概念'],
  ['new-conversation', '2. 单智能体模式'],
  ['chat-mode', '3. 聊天模式'],
  ['team-mode', '4. 团队模式'],
  ['choose-agent', '5. 助手与模型介绍'],
  ['choose-model', '6. 任务与模型'],
  ['permissions', '7. 权限与安全'],
  ['files-projects', '8. 文件与项目'],
  ['resources', '9. 额度与资源'],
  ['skills-settings', '10. 技能、定时任务与微信'],
  ['appropriate-use', '11. 适用范围'],
  ['scenarios', '12. 工作场景'],
  ['glossary', '13. 名词与命令'],
] as const;

const HelpPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <Button
          type='text'
          icon={<ArrowLeft />}
          className={styles.backButton}
          onClick={() => void navigate('/settings/about')}
        >
          {t('common.back')}
        </Button>
        <div className={styles.hero}>
          <img className={styles.heroLogo} src={brandLogo} alt='CLIENTNAME' />
          <div>
            <Typography.Title heading={2} className='!m-0 text-t-primary'>
              CLIENTNAME 智能体平台使用指南
            </Typography.Title>
            <p className={styles.subtitle}>从第一次对话到团队协作、文件管理与权限设置的完整操作说明</p>
          </div>
        </div>

        <section className={styles.overview} aria-label='文档目录'>
          <div className={styles.overviewLead}>
            <span>使用指南</span>
          </div>
          <nav className={styles.toc}>
            {guideSections.map(([id, label]) => (
              <button
                key={id}
                type='button'
                onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })}
              >
                <span>{label}</span>
                <Down theme='outline' size='12' />
              </button>
            ))}
          </nav>
        </section>

        <Typography.Title heading={3} className={styles.documentTitle}>
          {t('settings.helpPage.title')}
        </Typography.Title>
        <p className={styles.documentDescription}>{t('settings.helpPage.description')}</p>
        <article className={styles.guideArticle} dangerouslySetInnerHTML={{ __html: guideHtml }} />
      </div>
    </main>
  );
};

export default HelpPage;
