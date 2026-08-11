'use client';

import {useState} from 'react';
import CourseRunsWorkspace from './course-runs-workspace';
import LearnerOperationsWorkspace from './learner-operations-workspace';

export default function LmsWorkspace({slug,initialData}){
  const [view,setView]=useState('batches');
  return <main className="mt-admissions-page" dir="rtl">
    <header className="mt-page-head">
      <div>
        <small>INTERACTIVE TRAINING LMS</small>
        <h2>منصة التدريب التفاعلي</h2>
        <p>إدارة الدفعات والجداول والحضور والتقييم والشهادات والتواصل التشغيلي من شاشة مستقلة.</p>
      </div>
      <div className="mt-page-actions mt-admissions-view-switch">
        <button
          className={`mt-button ${view==='batches'?'primary':'soft'}`}
          onClick={()=>setView('batches')}
        >الدفعات والجداول</button>
        <button
          className={`mt-button ${view==='operations'?'primary':'soft'}`}
          onClick={()=>setView('operations')}
        >تشغيل المتدربين</button>
      </div>
    </header>

    {view==='batches'
      ?<CourseRunsWorkspace slug={slug} data={initialData}/>
      :<LearnerOperationsWorkspace
        slug={slug}
        data={initialData.trainingOperations}
        automation={initialData.trainingAutomation}
      />}
  </main>;
}
