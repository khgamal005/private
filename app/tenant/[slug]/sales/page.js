import {getTenantSalesWorkspace} from '../../../../lib/api';
import SalesWorkspace from '../../../../components/sales-workspace';
import {requireTenantPermission} from '../../../../lib/server-auth';
import {optionalServerRead} from '../../../../lib/server-resilience';

export const dynamic='force-dynamic';

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function unavailableSalesWorkspace(){
  return {
    schemaVersion:'tenant-sales-workspace-v1',
    unavailable:true,
    generatedAt:null,
    timezone:'UTC',
    viewer:{
      staffId:null,
      viewTeam:false,
      canWriteCrm:false,
      canReassign:false
    },
    summary:{},
    pagination:{
      limit:80,
      total:0,
      returned:0,
      hasMore:false,
      pipelineCounts:{}
    },
    focusedContact:null,
    contacts:[],
    auxiliaryIncluded:false,
    activities:[],
    registrationHandoffs:[],
    staff:[],
    courses:[],
    courseRuns:[]
  };
}

export default async function SalesPage({params,searchParams}){
  const {slug}=await params;
  const query=await searchParams;
  await requireTenantPermission(slug,'tenant.crm.read');
  const requestedContact=typeof query?.contact==='string'
    ?query.contact
    :'';
  const focusContactId=UUID_PATTERN.test(requestedContact)
    ?requestedContact
    :null;
  const initialData=await optionalServerRead(
    'tenant-sales-workspace',
    ()=>getTenantSalesWorkspace(slug,{focusContactId}),
    unavailableSalesWorkspace
  );
  return <SalesWorkspace
    slug={slug}
    initialData={initialData}
    focusContactId={focusContactId||''}
  />;
}
