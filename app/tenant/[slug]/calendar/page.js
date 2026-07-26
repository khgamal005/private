import {redirect} from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function CalendarPage({params}){
  const {slug}=await params;
  redirect(`/tenant/${encodeURIComponent(slug)}/tasks`);
}
