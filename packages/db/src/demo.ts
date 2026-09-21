import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrator.js';

const sourceUrl =
  process.env.DATABASE_URL ??
  'postgresql://openhall:openhall-development-only@localhost:5432/openhall';
const demoUrl = new URL(sourceUrl);
demoUrl.pathname = '/openhall_demo';

async function recreateDatabase(): Promise<void> {
  const adminUrl = new URL(demoUrl);
  adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'openhall_demo' AND pid <> pg_backend_pid()`,
    );
    await admin.query('DROP DATABASE IF EXISTS openhall_demo');
    await admin.query('CREATE DATABASE openhall_demo');
  } finally {
    await admin.end();
  }
}

const seedSql = `
INSERT INTO tenant (id, name, slug) VALUES ('10000000-0000-4000-8000-000000000001', 'Northstar Public Schools', 'northstar-demo');
INSERT INTO organization (id, tenant_id, kind, name, slug, time_zone) VALUES
('10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'school', 'Northstar Middle School', 'northstar-middle', 'America/New_York');

INSERT INTO person (id, tenant_id, given_name, family_name, display_name) VALUES
('10000000-0000-4000-8000-000000000201','10000000-0000-4000-8000-000000000001','Avery','Morgan','Avery Morgan'),
('10000000-0000-4000-8000-000000000202','10000000-0000-4000-8000-000000000001','Jordan','Lee','Jordan Lee'),
('10000000-0000-4000-8000-000000000203','10000000-0000-4000-8000-000000000001','Maya','Patel','Maya Patel'),
('10000000-0000-4000-8000-000000000204','10000000-0000-4000-8000-000000000001','Eli','Thompson','Eli Thompson'),
('10000000-0000-4000-8000-000000000205','10000000-0000-4000-8000-000000000001','Sofia','Ramirez','Sofia Ramirez'),
('10000000-0000-4000-8000-000000000206','10000000-0000-4000-8000-000000000001','Noah','Williams','Noah Williams'),
('10000000-0000-4000-8000-000000000207','10000000-0000-4000-8000-000000000001','Zoe','Chen','Zoe Chen'),
('10000000-0000-4000-8000-000000000208','10000000-0000-4000-8000-000000000001','Lucas','Johnson','Lucas Johnson');
INSERT INTO account (id, tenant_id, person_id) VALUES
('10000000-0000-4000-8000-000000000101','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000201'),
('10000000-0000-4000-8000-000000000102','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000202'),
('10000000-0000-4000-8000-000000000103','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000203');
INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation, grade_level) VALUES
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000201','staff',NULL),
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000202','staff',NULL),
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000203','student','8'),
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000204','student','8'),
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000205','student','8'),
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000206','student','8'),
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000207','student','8'),
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000208','student','8');

INSERT INTO academic_session (id,tenant_id,organization_id,kind,name,starts_on,ends_on) VALUES ('10000000-0000-4000-8000-000000000301','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','school_year','2026–27 School Year',current_date-60,current_date+240);
INSERT INTO course (id,tenant_id,organization_id,code,title) VALUES ('10000000-0000-4000-8000-000000000302','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','SCI-8','Physical Science');
INSERT INTO section (id,tenant_id,organization_id,course_id,academic_session_id,code,title) VALUES ('10000000-0000-4000-8000-000000000303','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000302','10000000-0000-4000-8000-000000000301','SCI-8A','Physical Science — Period 2');
INSERT INTO section_membership (tenant_id,section_id,person_id,role) SELECT '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000303',id,CASE WHEN id='10000000-0000-4000-8000-000000000202' THEN 'teacher' ELSE 'student' END FROM person WHERE id IN ('10000000-0000-4000-8000-000000000202','10000000-0000-4000-8000-000000000203','10000000-0000-4000-8000-000000000204','10000000-0000-4000-8000-000000000205','10000000-0000-4000-8000-000000000206','10000000-0000-4000-8000-000000000207','10000000-0000-4000-8000-000000000208');

INSERT INTO location (id,tenant_id,organization_id,kind,name,code,floor_label) VALUES
('10000000-0000-4000-8000-000000000401','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','classroom','Science Lab 214','214','2'),
('10000000-0000-4000-8000-000000000402','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','office','Health Office','NURSE','1'),
('10000000-0000-4000-8000-000000000403','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','restroom','Second Floor Restroom','R2','2'),
('10000000-0000-4000-8000-000000000404','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','office','Counseling Center','COUNSEL','1'),
('10000000-0000-4000-8000-000000000405','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','library','Library Media Center','LIB','1');
INSERT INTO destination (id,tenant_id,organization_id,location_id,service_type,display_name,capacity,queue_enabled,check_in_mode,default_duration_seconds,max_duration_seconds) VALUES
('10000000-0000-4000-8000-000000000501','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000402','health','Health Office',2,true,'required',900,1800),
('10000000-0000-4000-8000-000000000502','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000403','restroom','Second Floor Restroom',3,true,'none',420,900),
('10000000-0000-4000-8000-000000000503','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000404','counseling','Counseling Center',2,true,'optional',1200,2400),
('10000000-0000-4000-8000-000000000504','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000405','library','Library Media Center',12,false,'optional',1200,3600);

INSERT INTO authorization_grant (id,tenant_id,account_id,role,scope_kind,organization_id,created_by_account_id) VALUES ('10000000-0000-4000-8000-000000000601','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000101','school_admin','organization','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000101');
INSERT INTO authorization_grant (id,tenant_id,account_id,role,scope_kind,destination_id,created_by_account_id) VALUES ('10000000-0000-4000-8000-000000000602','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000102','destination_staff','destination','10000000-0000-4000-8000-000000000501','10000000-0000-4000-8000-000000000101');

INSERT INTO schedule_block (id,tenant_id,organization_id,code,display_name,kind) VALUES ('10000000-0000-4000-8000-000000000701','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','P2','Period 2','instructional');
INSERT INTO schedule_template (id,tenant_id,organization_id,name) VALUES ('10000000-0000-4000-8000-000000000702','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','Regular Day');
INSERT INTO schedule_slot (id,tenant_id,schedule_template_id,schedule_block_id,starts_at,ends_at,ordinal,organization_id) VALUES ('10000000-0000-4000-8000-000000000703','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000702','10000000-0000-4000-8000-000000000701','00:01','23:59',1,'10000000-0000-4000-8000-000000000002');
INSERT INTO section_meeting (id,tenant_id,section_id,schedule_block_id,location_id,organization_id) VALUES ('10000000-0000-4000-8000-000000000704','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000303','10000000-0000-4000-8000-000000000701','10000000-0000-4000-8000-000000000401','10000000-0000-4000-8000-000000000002');
INSERT INTO calendar_day (id,tenant_id,organization_id,date,day_kind,schedule_template_id) VALUES ('10000000-0000-4000-8000-000000000705','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',current_date,'instructional','10000000-0000-4000-8000-000000000702');

INSERT INTO policy_rule (id,tenant_id,organization_id,name,rule_type,scope_kind,scope_organization_id,priority,configuration,override_mode) VALUES
('10000000-0000-4000-8000-000000000801','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','Protect instructional time','schedule_boundary','organization','10000000-0000-4000-8000-000000000002',100,'{"schemaVersion":1,"firstMinutes":5,"lastMinutes":5}','authorized');
INSERT INTO policy_rule (id,tenant_id,organization_id,name,rule_type,scope_kind,scope_section_id,priority,configuration,override_mode) VALUES
('10000000-0000-4000-8000-000000000802','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','Teacher approval for science','approval_requirement','section','10000000-0000-4000-8000-000000000303',50,'{"schemaVersion":1,"requiredApprover":"current_section_teacher"}','never');

INSERT INTO scheduled_authorization (id,tenant_id,organization_id,student_id,destination_id,created_by_person_id,created_by_account_id,valid_from,valid_until,approval_mode,origin_strategy,display_category) VALUES
('10000000-0000-4000-8000-000000000901','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000203','10000000-0000-4000-8000-000000000503','10000000-0000-4000-8000-000000000201','10000000-0000-4000-8000-000000000101',now()+interval '1 hour',now()+interval '3 hours','preapproved','expected','Counselor appointment'),
('10000000-0000-4000-8000-000000000902','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000205','10000000-0000-4000-8000-000000000501','10000000-0000-4000-8000-000000000201','10000000-0000-4000-8000-000000000101',now()+interval '1 day',now()+interval '1 day 2 hours','approval_required','expected','Medication');

INSERT INTO pass (id,tenant_id,organization_id,student_id,origin_location_id,origin_section_id,destination_id,return_location_id,request_source,requested_by_person_id,requested_at,lifecycle_state,expected_return_at,revision,departure_check_in_mode,departure_destination_revision) VALUES
('10000000-0000-4000-8000-000000001001','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000204','10000000-0000-4000-8000-000000000401','10000000-0000-4000-8000-000000000303','10000000-0000-4000-8000-000000000502','10000000-0000-4000-8000-000000000401','student_web','10000000-0000-4000-8000-000000000204',now()-interval '3 minutes','requested',now()+interval '10 minutes',1,NULL,NULL),
('10000000-0000-4000-8000-000000001002','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000205','10000000-0000-4000-8000-000000000401','10000000-0000-4000-8000-000000000303','10000000-0000-4000-8000-000000000501','10000000-0000-4000-8000-000000000401','staff_web','10000000-0000-4000-8000-000000000202',now()-interval '7 minutes','outbound',now()+interval '18 minutes',3,'required',1),
('10000000-0000-4000-8000-000000001003','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000206','10000000-0000-4000-8000-000000000401','10000000-0000-4000-8000-000000000303','10000000-0000-4000-8000-000000000503','10000000-0000-4000-8000-000000000401','student_web','10000000-0000-4000-8000-000000000206',now()-interval '5 minutes','queued',now()+interval '25 minutes',2,NULL,NULL),
('10000000-0000-4000-8000-000000001004','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000207','10000000-0000-4000-8000-000000000401','10000000-0000-4000-8000-000000000303','10000000-0000-4000-8000-000000000504','10000000-0000-4000-8000-000000000401','student_web','10000000-0000-4000-8000-000000000207',now()-interval '2 days','completed',now()-interval '2 days 40 minutes',5,'optional',1);
INSERT INTO policy_evaluation (id,tenant_id,pass_id,stage,decision,pass_revision,context_snapshot,evaluated_at) VALUES
('10000000-0000-4000-8000-000000001101','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000001001','request','approval_required',1,'{}',now()-interval '3 minutes'),
('10000000-0000-4000-8000-000000001102','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000001002','request','allow',2,'{}',now()-interval '6 minutes'),
('10000000-0000-4000-8000-000000001103','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000001003','request','queue',2,'{}',now()-interval '4 minutes');
INSERT INTO policy_evaluation_result (id,tenant_id,evaluation_id,policy_rule_id,policy_rule_revision,outcome,reason_code,override_mode,rule_snapshot,contribution) VALUES
('10000000-0000-4000-8000-000000001111','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000001101','10000000-0000-4000-8000-000000000802',1,'fail','current_section_teacher_approval_required','never','{}','approval_required');
INSERT INTO pass_approval (id,tenant_id,organization_id,pass_id,origin_evaluation_result_id,policy_rule_id,policy_rule_revision,required_section_id) VALUES
('10000000-0000-4000-8000-000000001121','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000001001','10000000-0000-4000-8000-000000001111','10000000-0000-4000-8000-000000000802',1,'10000000-0000-4000-8000-000000000303');
INSERT INTO destination_reservation (id,tenant_id,destination_id,pass_id,reserved_at,ready_expires_at,organization_id,policy_evaluation_id,claimed_at,flow_expires_at) VALUES
('10000000-0000-4000-8000-000000001131','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000501','10000000-0000-4000-8000-000000001002',now()-interval '6 minutes',now()-interval '4 minutes','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000001102',now()-interval '5 minutes',now()+interval '20 minutes');
INSERT INTO queue_entry (id,tenant_id,destination_id,pass_id,entered_at,priority,organization_id,policy_evaluation_id,flow_expires_at) VALUES
('10000000-0000-4000-8000-000000001141','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000503','10000000-0000-4000-8000-000000001003',now()-interval '4 minutes',0,'10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000001103',now()+interval '25 minutes');
INSERT INTO pass_event (tenant_id,pass_id,sequence,event_type,actor_kind,actor_person_id,occurred_at,metadata) VALUES
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000001001',1,'pass.requested','person','10000000-0000-4000-8000-000000000204',now()-interval '3 minutes','{}'),
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000001002',1,'pass.requested','person','10000000-0000-4000-8000-000000000202',now()-interval '7 minutes','{}'),
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000001002',2,'pass.ready','system',NULL,now()-interval '6 minutes','{}'),
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000001002',3,'pass.departed','person','10000000-0000-4000-8000-000000000205',now()-interval '5 minutes','{}'),
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000001003',1,'pass.requested','person','10000000-0000-4000-8000-000000000206',now()-interval '5 minutes','{}'),
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000001003',2,'pass.queued','system',NULL,now()-interval '4 minutes','{}'),
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000001004',1,'pass.completed','system',NULL,now()-interval '2 days','{}');
INSERT INTO audit_event (tenant_id,organization_id,actor_kind,actor_id,action,target_kind,target_id,outcome,occurred_at,request_id,metadata) VALUES
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','account','10000000-0000-4000-8000-000000000101','destination.updated','destination','10000000-0000-4000-8000-000000000501','success',now()-interval '1 day','demo-audit-1','{"field":"capacity"}'),
('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','account','10000000-0000-4000-8000-000000000102','pass.requested','pass','10000000-0000-4000-8000-000000001002','success',now()-interval '7 minutes','demo-audit-2','{}');
`;

async function reset(): Promise<void> {
  await recreateDatabase();
  const handle = createDatabase(demoUrl.toString(), { max: 2 });
  try {
    await migrateToLatest(handle.database);
    await handle.pool.query(seedSql);
  } finally {
    await handle.destroy();
  }
  process.stdout.write(`OpenHall demo database reset: ${demoUrl.pathname.slice(1)}\n`);
}

await reset();
if (process.argv.includes('--serve')) {
  const child = spawn(
    'pnpm',
    [
      'exec',
      'concurrently',
      '-n',
      'api,web',
      '-c',
      'blue,green',
      'pnpm --filter @openhall/api dev',
      'pnpm --filter @openhall/web dev',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        OPENHALL_DEMO: 'true',
        APP_BASE_URL: 'http://localhost:5173',
        DATABASE_URL: demoUrl.toString(),
        APP_SECRET: 'openhall-local-demo-secret-at-least-32-characters',
        DATA_ENCRYPTION_KEY: 'd1891fe393da7c992d51a8f99ec6ee3ea4646b3aa574d3fd1fa37be90725f01d',
        DATA_ENCRYPTION_KEY_ID: 'openhall-local-demo-key',
        TRUST_PROXY: 'false',
        PORT: '3000',
      },
    },
  );
  process.on('SIGINT', () => {
    child.kill('SIGINT');
  });
  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
  });
  process.exitCode = await new Promise<number>((resolve) => {
    child.once('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}
