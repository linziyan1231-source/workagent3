export const PROFESSIONAL_DATABASE_SKILL_NAME = '专业数据库';
export const PROFESSIONAL_DATABASE_MCP_ID = 'workagent2-kimi-datasource';

export const DWG_QUANTITY_SKILL_NAME = 'dwg-quantity-surveyor';
export const DWG_QUANTITY_MCP_ID = 'workagent2-dwg-quantity';
export const DWG_QUANTITY_MCP_NAME = 'DWG Quantity Surveyor';

type McpIdentity = {
  id: string;
  name: string;
};

export const isProfessionalDatabaseSkill = (name: string): boolean => name.trim() === PROFESSIONAL_DATABASE_SKILL_NAME;

export const isProfessionalDatabaseMcp = (id: string): boolean => id.trim() === PROFESSIONAL_DATABASE_MCP_ID;

export const isDwgQuantitySkill = (name: string): boolean => name.trim() === DWG_QUANTITY_SKILL_NAME;

export const isDwgQuantityMcp = (server: McpIdentity): boolean =>
  server.id.trim() === DWG_QUANTITY_MCP_ID || server.name.trim() === DWG_QUANTITY_MCP_NAME;

export const resolveDwgQuantityMcpId = (servers: McpIdentity[]): string | undefined =>
  servers.find(isDwgQuantityMcp)?.id;
