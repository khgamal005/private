import {
  isSameBusinessDay,
  isTaskOverdue
} from './task-timing.mjs';

const EMPTY=[];
const OPEN_TASK_STATUSES=new Set(['todo','in_progress']);

function array(value){
  return Array.isArray(value)?value:EMPTY;
}

function taskContactId(task){
  return task?.contactId||task?.contact_id||null;
}

export function buildTaskCalendarInitialWindow(
  snapshot,
  {now=new Date()}={}
){
  const source=snapshot&&typeof snapshot==='object'?snapshot:{};
  const tasks=array(source.tasks);
  const contacts=array(source.contacts);
  const dailyLeadDistribution={
    total:0,
    taskIds:EMPTY,
    byStaff:EMPTY,
    items:EMPTY,
    ...(source.dailyLeadDistribution||{})
  };
  const distributionItems=array(dailyLeadDistribution.items);
  const timeZone=source.timezone||source.tenant?.timezone||'UTC';
  const isOpen=task=>OPEN_TASK_STATUSES.has(task?.status);
  const todayTasks=tasks.filter(task=>
    isOpen(task)&&isSameBusinessDay(task?.dueAt,now,timeZone)
  );
  const referencedContactIds=new Set(
    [...todayTasks,...distributionItems]
      .map(taskContactId)
      .filter(Boolean)
  );

  return {
    ...source,
    tasks:todayTasks,
    contacts:contacts.filter(contact=>referencedContactIds.has(contact?.id)),
    dailyLeadDistribution:{
      ...dailyLeadDistribution,
      taskIds:[...array(dailyLeadDistribution.taskIds)],
      byStaff:[...array(dailyLeadDistribution.byStaff)],
      items:[...distributionItems]
    },
    calendarSummary:{
      open:tasks.filter(isOpen).length,
      overdue:tasks.filter(task=>
        isOpen(task)&&isTaskOverdue(task,{now,timeZone})
      ).length,
      today:todayTasks.length,
      completedLate:tasks.filter(task=>
        task?.status==='completed'&&task?.completionTiming==='late'
      ).length
    },
    hasDemoTasks:tasks.some(task=>Boolean(task?.demo)),
    completeTaskCount:tasks.length,
    partial:true
  };
}
