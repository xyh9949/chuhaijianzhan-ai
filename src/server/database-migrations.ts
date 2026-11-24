import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
export const DATABASE_MIGRATIONS = [
    { version: 1, name: 'core-and-auth-host', sql: `
    CREATE TABLE IF NOT EXISTS cms_draft (
      id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL,
      schema_version INTEGER NOT NULL, content_json TEXT NOT NULL CHECK (json_valid(content_json)), updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cms_release (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
      manifest_hash TEXT NOT NULL, schema_version INTEGER NOT NULL, renderer_version INTEGER NOT NULL,
      created_by TEXT NOT NULL, author_name TEXT NOT NULL, created_at TEXT NOT NULL,
      selection_json TEXT NOT NULL CHECK (json_valid(selection_json))
    );
    CREATE TABLE IF NOT EXISTS cms_runtime (
      id INTEGER PRIMARY KEY CHECK (id = 1), active_release_id TEXT REFERENCES cms_release(id)
    );
    INSERT OR IGNORE INTO cms_runtime (id, active_release_id) VALUES (1, NULL);
    CREATE TABLE IF NOT EXISTS cms_release_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,
      release_id TEXT NOT NULL REFERENCES cms_release(id), actor_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cms_media_file (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL,
      bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cms_inquiry (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS cms_release_immutable_update BEFORE UPDATE ON cms_release
      BEGIN SELECT RAISE(ABORT, 'Published snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS cms_release_immutable_delete BEFORE DELETE ON cms_release
      BEGIN SELECT RAISE(ABORT, 'Published snapshots are retained'); END;
  ` },
    { version: 2, name: 'inquiry-notification-runtime', sql: `    -- 表单提交、通知及保留策略是运行数据，不随网站发布快照回退。
    CREATE TABLE IF NOT EXISTS cms_form_submission (
      nonce TEXT PRIMARY KEY, form_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      response_json TEXT NOT NULL CHECK(json_valid(response_json)), inquiry_id TEXT NOT NULL UNIQUE REFERENCES cms_inquiry(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cms_notification_job (
      id TEXT PRIMARY KEY, inquiry_id TEXT NOT NULL UNIQUE REFERENCES cms_inquiry(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('pending','processing','sent','mock_sent','failed','unconfigured')),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT, lease_until INTEGER, error_code TEXT NOT NULL DEFAULT '', provider_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cms_notification_due ON cms_notification_job(status,next_attempt);
    CREATE TABLE IF NOT EXISTS cms_public_rate (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS cms_public_rate_expiry ON cms_public_rate(expires_at);
    CREATE TABLE IF NOT EXISTS cms_inquiry_policy (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, retention_days INTEGER NOT NULL, updated_at TEXT NOT NULL);
    INSERT OR IGNORE INTO cms_inquiry_policy(id,revision,retention_days,updated_at) VALUES(1,0,0,'');
` },
    { version: 3, name: 'operation-audit', sql: `    -- 审计是独立运行数据，公开快照与网站回退不能覆盖它。
    CREATE TABLE IF NOT EXISTS cms_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
      action TEXT NOT NULL, result TEXT NOT NULL CHECK(result IN ('success','failure','started')),
      status INTEGER NOT NULL, details_json TEXT NOT NULL CHECK(json_valid(details_json)), created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cms_audit_action ON cms_audit(action,id);
    CREATE TRIGGER IF NOT EXISTS cms_audit_immutable_update BEFORE UPDATE ON cms_audit BEGIN SELECT RAISE(ABORT,'Audit records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS cms_audit_immutable_delete BEFORE DELETE ON cms_audit BEGIN SELECT RAISE(ABORT,'Audit records are retained'); END;
` },
    {version:4,name:'search-discovery-runtime',sql:`
    -- 提交、观测和可选抓取计数为实例运行数据；网站回退和分发不覆盖。
    CREATE TABLE IF NOT EXISTS cms_discovery_job(id TEXT PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,origin TEXT NOT NULL,urls_json TEXT NOT NULL CHECK(json_valid(urls_json)),status TEXT NOT NULL,attempts INTEGER NOT NULL,next_attempt INTEGER NOT NULL,response_code TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS cms_discovery_due ON cms_discovery_job(status,next_attempt);
    CREATE TABLE IF NOT EXISTS cms_discovery_observation(id INTEGER PRIMARY KEY AUTOINCREMENT,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),actor_id TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cms_discovery_crawl(day TEXT NOT NULL,path TEXT NOT NULL,agent TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(day,path,agent));
` },
    {version:5,name:'private-ai-builder-runtime',sql:`
    -- AI服务配置与生成暂存仅属于实例运行数据，不随网站发布或整站分发导出。
    CREATE TABLE IF NOT EXISTS cms_ai_provider(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),base_url TEXT NOT NULL,model TEXT NOT NULL,allow_local INTEGER NOT NULL CHECK(allow_local IN (0,1)),secret_cipher TEXT NOT NULL,updated_at TEXT NOT NULL);
    INSERT OR IGNORE INTO cms_ai_provider(id,revision,enabled,base_url,model,allow_local,secret_cipher,updated_at) VALUES(1,0,0,'','',0,'','');
    CREATE TABLE IF NOT EXISTS cms_ai_build(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('plan','preview')),base_revision INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,applied_revision INTEGER,applied_at TEXT);
    CREATE INDEX IF NOT EXISTS cms_ai_build_expiry ON cms_ai_build(expires_at);
` },
    {version:6,name:'private-ai-source-import',sql:`
    -- 原始公司资料与导入预检只属实例私有运行记录，不进入网站快照或跨客户分发。
    CREATE TABLE IF NOT EXISTS cms_ai_source(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('source','products','brief')),source_id TEXT,base_revision INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,applied_revision INTEGER,applied_at TEXT);
    CREATE INDEX IF NOT EXISTS cms_ai_source_expiry ON cms_ai_source(expires_at);
` },
    {version:7,name:'private-ai-page-edit',sql:`
    -- 局部修改的前后预览与撤销回执不进入网站业务数据及跨客户分发。
    CREATE TABLE IF NOT EXISTS cms_ai_edit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,page_id TEXT NOT NULL,base_revision INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,applied_revision INTEGER,applied_at TEXT,undone_revision INTEGER,undone_at TEXT);
    CREATE INDEX IF NOT EXISTS cms_ai_edit_expiry ON cms_ai_edit(expires_at);
` },
    {version:8,name:'private-seo-sources-and-proposals',sql:`
    -- 搜索凭据、授权状态、报告及优化回执均为实例私有记录，不进入站点/客户分发。
    CREATE TABLE IF NOT EXISTS cms_seo_connection(provider TEXT PRIMARY KEY CHECK(provider IN('gsc','dataforseo')),revision INTEGER NOT NULL,config_json TEXT NOT NULL CHECK(json_valid(config_json)),secret_cipher TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cms_seo_oauth_state(state_hash TEXT PRIMARY KEY,actor_id TEXT NOT NULL,connection_revision INTEGER NOT NULL,verifier_cipher TEXT NOT NULL,redirect_uri TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cms_seo_report(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,provider TEXT NOT NULL,connection_revision INTEGER NOT NULL,metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS cms_seo_report_owner ON cms_seo_report(actor_id,provider,created_at);
    CREATE TABLE IF NOT EXISTS cms_seo_proposal(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,target_kind TEXT NOT NULL,target_id TEXT NOT NULL,base_revision INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,applied_revision INTEGER,applied_at TEXT,undone_revision INTEGER,undone_at TEXT);
    CREATE INDEX IF NOT EXISTS cms_seo_proposal_expiry ON cms_seo_proposal(expires_at);
` },
    {version:9,name:'private-ai-content-writing',sql:`
    -- 写作依据、本人建议及字段撤销回执属于实例私有运行数据，不进入网站快照。
    CREATE TABLE IF NOT EXISTS cms_ai_writing_profile(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,config_json TEXT NOT NULL CHECK(json_valid(config_json)),updated_at TEXT NOT NULL);
    INSERT OR IGNORE INTO cms_ai_writing_profile VALUES(1,0,'{}','');
    CREATE TABLE IF NOT EXISTS cms_ai_writing_proposal(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,target_kind TEXT NOT NULL,target_id TEXT NOT NULL,profile_revision INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS cms_ai_writing_proposal_owner ON cms_ai_writing_proposal(actor_id,expires_at);
    CREATE TABLE IF NOT EXISTS cms_ai_writing_receipt(id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL,actor_id TEXT NOT NULL,target_kind TEXT NOT NULL,target_id TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),receipt_hash TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,saved_revision INTEGER NOT NULL,undone_revision INTEGER,UNIQUE(actor_id,proposal_id,receipt_hash));
    CREATE INDEX IF NOT EXISTS cms_ai_writing_receipt_owner ON cms_ai_writing_receipt(actor_id,expires_at);
` },
    {version:10,name:'private-ai-writing-save-confirmation',sql:`
    -- 保存完成标记与原生草稿同事务写入；零撤销字段也可查询，避免失联后误判保存结果。
    CREATE TABLE IF NOT EXISTS cms_ai_writing_save(id TEXT NOT NULL,actor_id TEXT NOT NULL,request_hash TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(actor_id,id));
    CREATE INDEX IF NOT EXISTS cms_ai_writing_save_owner ON cms_ai_writing_save(actor_id,expires_at);
` },
    {version:11,name:'private-ai-site-design',sql:`
    -- 整站AI候选与撤销回执是实例私有运行数据，不进入发布快照或源码分发包。
    CREATE TABLE IF NOT EXISTS cms_ai_site_design(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,base_revision INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,applied_revision INTEGER,applied_at TEXT,undone_revision INTEGER,undone_at TEXT);
    CREATE INDEX IF NOT EXISTS cms_ai_site_design_owner ON cms_ai_site_design(actor_id,expires_at);
` }
    ,{version:12,name:'private-external-ai-access',sql:`
    -- 机器凭据只存摘要；资源授权与请求幂等属于实例私有运行数据，不进入网站快照。
    CREATE TABLE IF NOT EXISTS cms_external_ai_token(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,token_hint TEXT NOT NULL,scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),page_ids_json TEXT NOT NULL CHECK(json_valid(page_ids_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,last_used_at TEXT);
    CREATE INDEX IF NOT EXISTS cms_external_ai_token_owner ON cms_external_ai_token(actor_id,expires_at);
    CREATE TABLE IF NOT EXISTS cms_external_ai_request(token_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,design_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(token_id,request_id));
    CREATE INDEX IF NOT EXISTS cms_external_ai_request_design ON cms_external_ai_request(token_id,design_id);
` }
    ,{version:13,name:'private-external-ai-content-and-seo',sql:`
    -- 新域默认空授权，旧设计凭据不因升级获得文章、产品或搜索资料权限。
    ALTER TABLE cms_external_ai_token ADD COLUMN record_ids_json TEXT NOT NULL DEFAULT '{"productIds":[],"entryIds":[]}' CHECK(json_valid(record_ids_json));
    CREATE TABLE cms_external_ai_writing(id TEXT PRIMARY KEY,token_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,applied_revision INTEGER,undone_revision INTEGER,UNIQUE(token_id,request_id));
    CREATE INDEX cms_external_ai_writing_owner ON cms_external_ai_writing(actor_id,expires_at);
    CREATE TABLE cms_external_ai_seo_request(token_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,proposal_id TEXT NOT NULL,parent_proposal_id TEXT,payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,PRIMARY KEY(token_id,request_id));
    CREATE INDEX cms_external_ai_seo_proposal ON cms_external_ai_seo_request(token_id,proposal_id);
` }
    ,{version:14,name:'private-ai-detail-template-design',sql:`
    -- 详情模板采用单独回执，旧程序不能忽略新模板变化却误记采用；旧凭据默认无模板授权。
    ALTER TABLE cms_external_ai_token ADD COLUMN template_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(template_ids_json));
    CREATE TABLE cms_ai_template_design(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,template_id TEXT NOT NULL,base_revision INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,applied_revision INTEGER,applied_at TEXT,undone_revision INTEGER,undone_at TEXT);
    CREATE INDEX cms_ai_template_design_owner ON cms_ai_template_design(actor_id,expires_at);
    CREATE TABLE cms_external_ai_template_request(token_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,design_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(token_id,request_id));
    CREATE INDEX cms_external_ai_template_design ON cms_external_ai_template_request(token_id,design_id);
` },
    {version:15,name:'private-mail-settings',sql:`
    -- 邮件配置属于实例私有运行数据，无记录时沿用旧环境；保存后无需发布即可供通知队列使用。
    CREATE TABLE cms_mail_settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,config_json TEXT NOT NULL CHECK(json_valid(config_json)),secret_cipher TEXT NOT NULL,updated_at TEXT NOT NULL);
` },
    {version:16,name:'private-launch-check-and-mail-evidence',sql:`
    -- 上线检查与邮件验证是实例私有证据；按版本/来源绑定，不进入发布内容或由“已配置”伪装验证通过。
    CREATE TABLE cms_launch_check(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,base_revision INTEGER NOT NULL,release_id TEXT,public_url TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE INDEX cms_launch_check_owner ON cms_launch_check(actor_id,created_at);
    CREATE TABLE cms_service_test_receipt(id TEXT PRIMARY KEY,service TEXT NOT NULL CHECK(service IN('mail','ai')),actor_id TEXT NOT NULL,configuration_revision INTEGER NOT NULL,configuration_source TEXT NOT NULL,configuration_fingerprint TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,error_code TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX cms_service_test_receipt_configuration ON cms_service_test_receipt(service,configuration_source,configuration_revision,created_at);
` },
    {version:17,name:'private-ai-design-guidance',sql:`
    -- 设计参考与人工确认反馈独立版本保存，不混入写作事实、公开快照或自动学习记录。
    CREATE TABLE cms_ai_design_guidance(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,config_json TEXT NOT NULL CHECK(json_valid(config_json)),updated_at TEXT NOT NULL);
` },
    {version:18,name:'private-ai-visual-and-translation',sql:`
    -- 可选视觉模型沿原加密连接共用来源/密钥；截图、评审和翻译候选均为本人私有，不进入站点导出。
    ALTER TABLE cms_ai_provider ADD COLUMN vision_model TEXT NOT NULL DEFAULT '';
    CREATE TABLE cms_ai_visual_capture(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,target_kind TEXT NOT NULL,target_id TEXT NOT NULL,page_id TEXT,base_revision INTEGER NOT NULL,source_hash TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE INDEX cms_ai_visual_capture_owner ON cms_ai_visual_capture(actor_id,expires_at);
    CREATE TABLE cms_ai_visual_review(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,capture_id TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE INDEX cms_ai_visual_review_owner ON cms_ai_visual_review(actor_id,expires_at);
    CREATE TABLE cms_ai_translation(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('product','entry')),source_id TEXT NOT NULL,target_locale TEXT NOT NULL,base_revision INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,applied_revision INTEGER,applied_at TEXT,undone_revision INTEGER,undone_at TEXT);
    CREATE INDEX cms_ai_translation_actor ON cms_ai_translation(actor_id,created_at);
` },
    {version:19,name:'ai-production-workflows',sql:`
    -- 七项完善的私有任务、用量及OAuth凭据均独立于公开快照，原迁移逐字保留。
    CREATE TABLE cms_ai_site_translation(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,base_revision INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,applied_revision INTEGER,applied_at TEXT,undone_revision INTEGER,undone_at TEXT);
    CREATE INDEX cms_ai_site_translation_owner ON cms_ai_site_translation(actor_id,expires_at);
    CREATE TABLE cms_ai_translation_glossary(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,config_json TEXT NOT NULL CHECK(json_valid(config_json)),updated_at TEXT NOT NULL);
    CREATE TABLE cms_ai_site_translation_binding(kind TEXT NOT NULL,source_id TEXT NOT NULL,target_locale TEXT NOT NULL,target_id TEXT NOT NULL,source_hash TEXT NOT NULL,target_hash TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,source_id,target_locale));
    CREATE TABLE cms_seo_content_proposal(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,target_kind TEXT NOT NULL,target_id TEXT NOT NULL,base_revision INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),reserved_bytes INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,applied_revision INTEGER,undone_revision INTEGER);
    CREATE INDEX cms_seo_content_owner ON cms_seo_content_proposal(actor_id,expires_at);
    CREATE TABLE cms_ai_usage(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,task TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,error_code TEXT NOT NULL DEFAULT '',input_chars INTEGER NOT NULL,output_chars INTEGER,input_tokens INTEGER,output_tokens INTEGER,total_tokens INTEGER,image_count INTEGER NOT NULL DEFAULT 0,duration_ms INTEGER NOT NULL,pricing_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(pricing_json)),job_id TEXT,created_at TEXT NOT NULL);
    CREATE INDEX cms_ai_usage_owner ON cms_ai_usage(actor_id,created_at);
    CREATE TABLE cms_ai_pricing(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,config_json TEXT NOT NULL CHECK(json_valid(config_json)),updated_at TEXT NOT NULL);
    CREATE TABLE cms_ai_batch_job(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,kind TEXT NOT NULL,config_json TEXT NOT NULL CHECK(json_valid(config_json)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE INDEX cms_ai_batch_owner ON cms_ai_batch_job(actor_id,created_at);
    CREATE TABLE cms_ai_batch_item(job_id TEXT NOT NULL REFERENCES cms_ai_batch_job(id) ON DELETE CASCADE,position INTEGER NOT NULL,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,status TEXT NOT NULL,operation_id TEXT,request_json TEXT NOT NULL CHECK(json_valid(request_json)),result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json)),error_code TEXT NOT NULL DEFAULT '',started_at TEXT,completed_at TEXT,PRIMARY KEY(job_id,position));
    CREATE TABLE cms_mcp_oauth_client(id TEXT PRIMARY KEY,metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE TABLE cms_mcp_oauth_request(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT);
    CREATE INDEX cms_mcp_oauth_request_expiry ON cms_mcp_oauth_request(expires_at);
    CREATE TABLE cms_mcp_oauth_code(code_hash TEXT PRIMARY KEY,client_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT);
    CREATE TABLE cms_mcp_oauth_refresh(token_hash TEXT PRIMARY KEY,family_id TEXT NOT NULL,client_id TEXT NOT NULL,actor_id TEXT NOT NULL,grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),access_token_id TEXT NOT NULL,resource TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT,revoked_at TEXT);
    CREATE INDEX cms_mcp_oauth_refresh_family ON cms_mcp_oauth_refresh(family_id);
    CREATE TABLE cms_mcp_oauth_access(token_id TEXT PRIMARY KEY REFERENCES cms_external_ai_token(id),client_id TEXT NOT NULL,actor_id TEXT NOT NULL,family_id TEXT NOT NULL,resource TEXT NOT NULL);
    CREATE INDEX cms_mcp_oauth_access_family ON cms_mcp_oauth_access(family_id);
` },
] as const;
/** 有序、同事务记录迁移；既有幂等表只登记，不重建客户数据；新版本数据库拒绝旧程序启动。 */
export function migrateDatabase(db: Database.Database) {
    db.transaction(() => {
        db.exec('CREATE TABLE IF NOT EXISTS cms_schema_migration(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
        const rows = db.prepare('SELECT version,checksum FROM cms_schema_migration ORDER BY version').all() as {
            version: number;
            checksum: string;
        }[];
        for (const [index, row] of rows.entries()) {
            const migration = DATABASE_MIGRATIONS.find(m => m.version === row.version);
            if (row.version !== index + 1 || !migration || createHash('sha256').update(migration.sql).digest('hex') !== row.checksum)
                throw new Error('数据库迁移版本或校验不兼容，请使用匹配应用与完整备份');
        }
        for (const migration of DATABASE_MIGRATIONS) {
            if (rows.some(r => r.version === migration.version))
                continue;
            db.exec(migration.sql);
            db.prepare('INSERT INTO cms_schema_migration(version,name,checksum,applied_at) VALUES(?,?,?,?)').run(migration.version, migration.name, createHash('sha256').update(migration.sql).digest('hex'), new Date().toISOString());
        }
    }).immediate();
}
