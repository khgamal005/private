import TaskCalendarPage from '../../../../components/task-calendar-page';

export const dynamic='force-dynamic';

export default async function TasksPage({params}){
  const {slug}=await params;
  return <TaskCalendarPage slug={slug} embedded/>;
}
