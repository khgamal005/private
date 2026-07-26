import KnowledgeFeed from '../../../../components/knowledge-feed';
export const dynamic='force-dynamic';
export default async function Page({params}){const {slug}=await params;return <KnowledgeFeed tenant={slug}/>}