from __future__ import annotations
import sqlite3
from pathlib import Path
from datetime import datetime

BASE = Path(__file__).resolve().parent.parent
DB_PATH = BASE / "data" / "fmt_tbs.db"

SCHEMA = r'''
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT UNIQUE NOT NULL,
 full_name TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'Staff',
 active INTEGER NOT NULL DEFAULT 1,
 email TEXT,
 phone TEXT,
 position TEXT,
 division TEXT DEFAULT 'FMT',
 site TEXT DEFAULT 'TBS',
 photo_path TEXT,
 last_login_at TEXT,
 failed_logins INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL,
 expires_at TEXT NOT NULL,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS role_permissions (
 role TEXT NOT NULL,
 permission TEXT NOT NULL,
 PRIMARY KEY(role,permission)
);
CREATE TABLE IF NOT EXISTS user_permissions (
 user_id INTEGER NOT NULL,
 permission TEXT NOT NULL,
 allowed INTEGER NOT NULL,
 PRIMARY KEY(user_id,permission),
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS attendance_batches (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 batch_token TEXT UNIQUE NOT NULL,
 period TEXT,
 site TEXT,
 division TEXT,
 uploaded_by INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(uploaded_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS attendance (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 employee_name TEXT NOT NULL,
 nik TEXT,
 position TEXT,
 division TEXT,
 location TEXT,
 period TEXT NOT NULL,
 notes TEXT,
 status TEXT NOT NULL DEFAULT 'Uploaded',
 current_version INTEGER NOT NULL DEFAULT 1,
 reviewer_id INTEGER,
 approver_id INTEGER,
 approved_at TEXT,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 batch_id INTEGER,
 page_count INTEGER,
 page_width REAL,
 page_height REAL,
 signed_file_path TEXT,
 final_checksum TEXT,
 signed_by INTEGER,
 signed_at TEXT,
 FOREIGN KEY(created_by) REFERENCES users(id),
 FOREIGN KEY(reviewer_id) REFERENCES users(id),
 FOREIGN KEY(approver_id) REFERENCES users(id),
 FOREIGN KEY(batch_id) REFERENCES attendance_batches(id) ON DELETE SET NULL,
 FOREIGN KEY(signed_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS attendance_versions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 attendance_id INTEGER NOT NULL,
 version INTEGER NOT NULL,
 file_path TEXT NOT NULL,
 original_name TEXT NOT NULL,
 notes TEXT,
 status TEXT NOT NULL,
 uploaded_by INTEGER NOT NULL,
 uploaded_at TEXT NOT NULL,
 checksum TEXT,
 UNIQUE(attendance_id, version),
 FOREIGN KEY(attendance_id) REFERENCES attendance(id) ON DELETE CASCADE,
 FOREIGN KEY(uploaded_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS attendance_findings (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 attendance_id INTEGER NOT NULL,
 page INTEGER NOT NULL,
 category TEXT NOT NULL,
 severity TEXT NOT NULL,
 description TEXT NOT NULL,
 comment TEXT,
 resolved INTEGER NOT NULL DEFAULT 0,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 resolved_at TEXT,
 FOREIGN KEY(attendance_id) REFERENCES attendance(id) ON DELETE CASCADE,
 FOREIGN KEY(created_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS signatures (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 signer_name TEXT NOT NULL,
 owner_id INTEGER NOT NULL,
 visibility TEXT NOT NULL DEFAULT 'Private',
 allowed_role TEXT,
 file_path TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,
 is_default INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS attendance_signature_placements (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 attendance_id INTEGER NOT NULL,
 signature_id INTEGER NOT NULL,
 page INTEGER NOT NULL,
 placement_slot INTEGER NOT NULL DEFAULT 1,
 nx REAL NOT NULL,
 ny REAL NOT NULL,
 nw REAL NOT NULL,
 nh REAL NOT NULL,
 created_by INTEGER NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(attendance_id) REFERENCES attendance(id) ON DELETE CASCADE,
 FOREIGN KEY(signature_id) REFERENCES signatures(id) ON DELETE CASCADE,
 FOREIGN KEY(created_by) REFERENCES users(id),
 UNIQUE(attendance_id,signature_id,page,placement_slot)
);
CREATE TABLE IF NOT EXISTS signature_page_locks (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 attendance_id INTEGER NOT NULL,
 source_page INTEGER NOT NULL,
 target_page INTEGER NOT NULL,
 created_by INTEGER NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(attendance_id) REFERENCES attendance(id) ON DELETE CASCADE,
 FOREIGN KEY(created_by) REFERENCES users(id),
 UNIQUE(attendance_id,target_page)
);
CREATE INDEX IF NOT EXISTS idx_signature_page_locks_source ON signature_page_locks(attendance_id,source_page);

CREATE TABLE IF NOT EXISTS attendance_sign_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 attendance_id INTEGER NOT NULL,
 version INTEGER NOT NULL,
 signature_id INTEGER NOT NULL,
 page INTEGER NOT NULL,
 nx REAL NOT NULL, ny REAL NOT NULL, nw REAL NOT NULL, nh REAL NOT NULL,
 signed_by INTEGER NOT NULL,
 signed_at TEXT NOT NULL,
 checksum TEXT NOT NULL,
 FOREIGN KEY(attendance_id) REFERENCES attendance(id) ON DELETE CASCADE,
 FOREIGN KEY(signature_id) REFERENCES signatures(id),
 FOREIGN KEY(signed_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS signature_position_templates (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 signature_id INTEGER NOT NULL,
 page_count INTEGER NOT NULL,
 page_width REAL NOT NULL,
 page_height REAL NOT NULL,
 page_rotation INTEGER NOT NULL DEFAULT 0,
 layout_fingerprint TEXT,
 page INTEGER NOT NULL,
 placement_slot INTEGER NOT NULL DEFAULT 1,
 nx REAL NOT NULL,
 ny REAL NOT NULL,
 nw REAL NOT NULL,
 nh REAL NOT NULL,
 label TEXT,
 created_by INTEGER NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(signature_id) REFERENCES signatures(id) ON DELETE CASCADE,
 FOREIGN KEY(created_by) REFERENCES users(id),
 UNIQUE(signature_id,page_count,page_width,page_height,page,placement_slot)
);
CREATE TABLE IF NOT EXISTS assets (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 asset_id TEXT UNIQUE NOT NULL,
 asset_name TEXT NOT NULL,
 category TEXT,brand TEXT,serial_number TEXT,location TEXT,pic TEXT,
 condition TEXT DEFAULT 'Good',status TEXT DEFAULT 'Active',notes TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_photos (
 id INTEGER PRIMARY KEY AUTOINCREMENT,asset_id INTEGER NOT NULL,file_path TEXT NOT NULL,
 original_name TEXT NOT NULL,is_main INTEGER NOT NULL DEFAULT 0,uploaded_at TEXT NOT NULL,
 FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tools (
 id INTEGER PRIMARY KEY AUTOINCREMENT,tool_id TEXT UNIQUE NOT NULL,tool_name TEXT NOT NULL,
 category TEXT,brand TEXT,serial_number TEXT,location TEXT,pic TEXT,condition TEXT DEFAULT 'Good',
 status TEXT DEFAULT 'Available',notes TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_photos (
 id INTEGER PRIMARY KEY AUTOINCREMENT,tool_id INTEGER NOT NULL,file_path TEXT NOT NULL,
 original_name TEXT NOT NULL,is_main INTEGER NOT NULL DEFAULT 0,uploaded_at TEXT NOT NULL,
 FOREIGN KEY(tool_id) REFERENCES tools(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS consumables (
 id INTEGER PRIMARY KEY AUTOINCREMENT,item_id TEXT UNIQUE NOT NULL,item_name TEXT NOT NULL,
 category TEXT,unit TEXT,location TEXT,current_stock REAL NOT NULL DEFAULT 0,
 minimum_stock REAL NOT NULL DEFAULT 0,notes TEXT,photo_path TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_transactions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,consumable_id INTEGER NOT NULL,transaction_type TEXT NOT NULL,
 quantity REAL NOT NULL,before_stock REAL NOT NULL,after_stock REAL NOT NULL,notes TEXT,
 created_by INTEGER NOT NULL,created_at TEXT NOT NULL,
 FOREIGN KEY(consumable_id) REFERENCES consumables(id) ON DELETE CASCADE,
 FOREIGN KEY(created_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS tickets (
 id INTEGER PRIMARY KEY AUTOINCREMENT,ticket_id TEXT UNIQUE NOT NULL,ticket_type TEXT NOT NULL,title TEXT NOT NULL,
 category TEXT,site TEXT,location TEXT,requested_by TEXT,assigned_to TEXT,priority TEXT DEFAULT 'Medium',severity TEXT,
 risk TEXT,impact TEXT,planned_start TEXT,planned_end TEXT,implementation_plan TEXT,rollback_plan TEXT,root_cause TEXT,
 action_taken TEXT,resolution_time TEXT,temporary_solution TEXT,permanent_solution TEXT,corrective_action TEXT,
 preventive_action TEXT,related_ticket TEXT,status TEXT NOT NULL DEFAULT 'Open',created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(created_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS ticket_attachments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,ticket_id INTEGER NOT NULL,file_path TEXT NOT NULL,original_name TEXT NOT NULL,
 description TEXT,uploaded_by INTEGER NOT NULL,uploaded_at TEXT NOT NULL,
 FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,FOREIGN KEY(uploaded_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS ticket_activity (
 id INTEGER PRIMARY KEY AUTOINCREMENT,ticket_id INTEGER NOT NULL,action TEXT NOT NULL,note TEXT,actor_id INTEGER NOT NULL,
 created_at TEXT NOT NULL,FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,FOREIGN KEY(actor_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS import_jobs (
 token TEXT PRIMARY KEY,user_id INTEGER NOT NULL,kind TEXT NOT NULL,file_path TEXT NOT NULL,original_name TEXT NOT NULL,
 created_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,action TEXT NOT NULL,module TEXT NOT NULL,record_ref TEXT,
 old_value TEXT,new_value TEXT,created_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id)
);
'''


INDEXES = r'''
CREATE INDEX IF NOT EXISTS idx_attendance_status ON attendance(status);
CREATE INDEX IF NOT EXISTS idx_attendance_period ON attendance(period);
CREATE INDEX IF NOT EXISTS idx_attendance_batch ON attendance(batch_id);
CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(asset_name);
CREATE INDEX IF NOT EXISTS idx_tools_name ON tools(tool_name);
CREATE INDEX IF NOT EXISTS idx_consumables_name ON consumables(item_name);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_type ON tickets(ticket_type);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
'''

DEFAULT_SETTINGS = {
    'title': 'FMT Operations Dashboard',
    'subtitle': 'Facility Management Operations & Inventory System',
    'footer': 'Powered by Edwin Mohamad',
    'division': 'FMT',
    'site': 'TBS',
    'environment': 'PRODUCTION',
}

ROLE_PERMISSIONS = {
    'Administrator': {'*'},
    'Staff': {
        'dashboard.view','attendance.view','attendance.upload','attendance.review','attendance.download',
        'asset.view','asset.create','asset.edit','asset.import','asset.export',
        'tools.view','tools.create','tools.edit','tools.import','tools.export',
        'consumable.view','consumable.create','consumable.edit','consumable.stock_in','consumable.stock_out','consumable.adjustment','consumable.export',
        'change.view','change.create','change.edit','incident.view','incident.create','incident.edit','incident.resolve',
        'problem.view','problem.create','problem.edit','report.view','report.export','profile.edit'
    },
    'Approver': {
        'dashboard.view','attendance.view','attendance.review','attendance.sign','attendance.sign_bulk','attendance.finalize','attendance.download',
        'signature.view','signature.use','change.view','change.approve','incident.view','incident.resolve','problem.view',
        'report.view','report.export','profile.edit'
    },
    'Viewer': {'dashboard.view','attendance.view','attendance.download','asset.view','tools.view','consumable.view','change.view','incident.view','problem.view','report.view','report.export'}
}


def now():
    return datetime.now().isoformat(timespec='seconds')


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys = ON')
    con.execute('PRAGMA journal_mode = WAL')
    con.execute('PRAGMA busy_timeout = 10000')
    con.execute('PRAGMA synchronous = NORMAL')
    return con


def _add_column_if_missing(con, table: str, column: str, ddl: str):
    cols = {r['name'] for r in con.execute(f'PRAGMA table_info({table})').fetchall()}
    if column not in cols:
        con.execute(f'ALTER TABLE {table} ADD COLUMN {column} {ddl}')



def _migrate_signature_placement_slots(con):
    """Upgrade legacy placement/template tables so one signature can appear multiple times on one page."""
    cols={r['name'] for r in con.execute('PRAGMA table_info(attendance_signature_placements)').fetchall()}
    if cols and 'placement_slot' not in cols:
        con.execute('ALTER TABLE attendance_signature_placements RENAME TO attendance_signature_placements_legacy')
        con.executescript("""
        CREATE TABLE attendance_signature_placements (
         id INTEGER PRIMARY KEY AUTOINCREMENT, attendance_id INTEGER NOT NULL, signature_id INTEGER NOT NULL, page INTEGER NOT NULL,
         placement_slot INTEGER NOT NULL DEFAULT 1, nx REAL NOT NULL, ny REAL NOT NULL, nw REAL NOT NULL, nh REAL NOT NULL, created_by INTEGER NOT NULL, updated_at TEXT NOT NULL,
         FOREIGN KEY(attendance_id) REFERENCES attendance(id) ON DELETE CASCADE, FOREIGN KEY(signature_id) REFERENCES signatures(id) ON DELETE CASCADE, FOREIGN KEY(created_by) REFERENCES users(id),
         UNIQUE(attendance_id,signature_id,page,placement_slot));
        INSERT INTO attendance_signature_placements(id,attendance_id,signature_id,page,placement_slot,nx,ny,nw,nh,created_by,updated_at)
        SELECT id,attendance_id,signature_id,page,1,nx,ny,nw,nh,created_by,updated_at FROM attendance_signature_placements_legacy;
        DROP TABLE attendance_signature_placements_legacy;
        """)
    cols={r['name'] for r in con.execute('PRAGMA table_info(signature_position_templates)').fetchall()}
    if cols and 'placement_slot' not in cols:
        con.execute('ALTER TABLE signature_position_templates RENAME TO signature_position_templates_legacy')
        con.executescript("""
        CREATE TABLE signature_position_templates (
         id INTEGER PRIMARY KEY AUTOINCREMENT, signature_id INTEGER NOT NULL, page_count INTEGER NOT NULL, page_width REAL NOT NULL, page_height REAL NOT NULL,
         page_rotation INTEGER NOT NULL DEFAULT 0, layout_fingerprint TEXT, page INTEGER NOT NULL, placement_slot INTEGER NOT NULL DEFAULT 1,
         nx REAL NOT NULL, ny REAL NOT NULL, nw REAL NOT NULL, nh REAL NOT NULL, label TEXT, created_by INTEGER NOT NULL, updated_at TEXT NOT NULL,
         FOREIGN KEY(signature_id) REFERENCES signatures(id) ON DELETE CASCADE, FOREIGN KEY(created_by) REFERENCES users(id),
         UNIQUE(signature_id,page_count,page_width,page_height,page,placement_slot));
        INSERT INTO signature_position_templates(id,signature_id,page_count,page_width,page_height,page_rotation,layout_fingerprint,page,placement_slot,nx,ny,nw,nh,label,created_by,updated_at)
        SELECT id,signature_id,page_count,page_width,page_height,COALESCE(page_rotation,0),layout_fingerprint,page,1,nx,ny,nw,nh,label,created_by,updated_at FROM signature_position_templates_legacy;
        DROP TABLE signature_position_templates_legacy;
        """)

def init_db():
    with connect() as con:
        con.executescript(SCHEMA)
        # Safe in-place migration for older deployments.
        for name, ddl in [
            ('email','TEXT'),('phone','TEXT'),('position','TEXT'),('division',"TEXT DEFAULT 'FMT'"),('site',"TEXT DEFAULT 'TBS'"),
            ('photo_path','TEXT'),('last_login_at','TEXT'),('failed_logins','INTEGER NOT NULL DEFAULT 0')
        ]:
            _add_column_if_missing(con,'users',name,ddl)
        for name, ddl in [
            ('batch_id','INTEGER REFERENCES attendance_batches(id) ON DELETE SET NULL'),('page_count','INTEGER'),('page_width','REAL'),('page_height','REAL'),('signed_file_path','TEXT'),
            ('final_checksum','TEXT'),('signed_by','INTEGER REFERENCES users(id)'),('signed_at','TEXT')
        ]:
            _add_column_if_missing(con,'attendance',name,ddl)
        _add_column_if_missing(con,'attendance_versions','checksum','TEXT')
        _migrate_signature_placement_slots(con)
        _add_column_if_missing(con,'signature_position_templates','page_rotation','INTEGER NOT NULL DEFAULT 0')
        _add_column_if_missing(con,'signature_position_templates','layout_fingerprint','TEXT')
        # Indexes MUST be created only after all legacy-column migrations above.
        # Older deployments may have an attendance table without batch_id; creating
        # idx_attendance_batch before ALTER TABLE causes startup to fail.
        con.executescript(INDEXES)
        for k,v in DEFAULT_SETTINGS.items():
            con.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING',(k,v))
        # Seed role permissions, but do not overwrite explicit admin changes already present.
        if con.execute('SELECT COUNT(*) c FROM role_permissions').fetchone()['c'] == 0:
            for role, perms in ROLE_PERMISSIONS.items():
                for perm in perms:
                    con.execute('INSERT OR IGNORE INTO role_permissions(role,permission) VALUES(?,?)',(role,perm))
        con.commit()


def q(sql, params=(), one=False):
    with connect() as con:
        cur = con.execute(sql, params)
        rows = cur.fetchall()
        return (rows[0] if rows else None) if one else rows


def execute(sql, params=()):
    with connect() as con:
        cur = con.execute(sql, params)
        con.commit()
        return cur.lastrowid


def audit(user_id, action, module, record_ref=None, old_value=None, new_value=None):
    execute('INSERT INTO audit_logs(user_id,action,module,record_ref,old_value,new_value,created_at) VALUES(?,?,?,?,?,?,?)',
            (user_id, action, module, record_ref, old_value, new_value, now()))
