import KnowledgeFeed from '../../../../components/knowledge-feed';

export const dynamic='force-dynamic';

export default async function NewsPage({params}){
  const {slug}=await params;
  return <KnowledgeFeed tenant={slug} embedded/>;
}
