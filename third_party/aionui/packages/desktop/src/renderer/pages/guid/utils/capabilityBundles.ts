export const PROFESSIONAL_DATABASE_SKILL_NAME = '专业数据库';
export const PROFESSIONAL_DATABASE_MCP_ID = 'workagent2-kimi-datasource';

export const isProfessionalDatabaseSkill = (name: string): boolean => name.trim() === PROFESSIONAL_DATABASE_SKILL_NAME;

export const isProfessionalDatabaseMcp = (id: string): boolean => id.trim() === PROFESSIONAL_DATABASE_MCP_ID;
