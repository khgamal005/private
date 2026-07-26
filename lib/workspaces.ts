export const WORKSPACE_KINDS = {
  platform: 'platform',
  tenant: 'tenant'
} as const;

export type WorkspaceKind =
  (typeof WORKSPACE_KINDS)[keyof typeof WORKSPACE_KINDS];

export const WORKSPACE_ROOTS = {
  platform: '/control',
  tenant: '/tenant'
} as const satisfies Record<WorkspaceKind, `/${string}`>;
