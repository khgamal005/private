import {requirePlatform} from '../../lib/server-auth';
import WorkspaceShell from '../../components/workspace-shell';

export const dynamic='force-dynamic';

export default async function ControlLayout({children}){
  const context=await requirePlatform();
  return <WorkspaceShell kind="platform" title="Marktone Platform Control" email={context.subject.email}>
    {children}
  </WorkspaceShell>;
}
