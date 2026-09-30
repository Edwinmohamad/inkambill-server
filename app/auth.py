from __future__ import annotations
import os, hashlib, hmac, secrets
from datetime import datetime, timedelta
from fastapi import Request, HTTPException
from .db import q, execute, now

COOKIE = 'fmt_session'
SESSION_HOURS = int(os.getenv('FMT_SESSION_HOURS','12'))
COOKIE_SECURE = os.getenv('FMT_COOKIE_SECURE','0').lower() in {'1','true','yes','on'}
DEFAULT_ADMIN_USER = os.getenv('FMT_ADMIN_USER','admin').strip() or 'admin'
DEFAULT_ADMIN_PASSWORD = os.getenv('FMT_ADMIN_PASSWORD','admin')


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16); rounds = 310000
    dk = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, rounds)
    return f'pbkdf2_sha256${rounds}${salt.hex()}${dk.hex()}'


def verify_password(password: str, stored: str) -> bool:
    try:
        _algo, rounds, salt_hex, digest_hex = stored.split('$')
        dk = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt_hex), int(rounds))
        return hmac.compare_digest(dk.hex(), digest_hex)
    except Exception:
        return False


def bootstrap_admin():
    if not q('SELECT id FROM users LIMIT 1', one=True):
        execute('INSERT INTO users(username,full_name,password_hash,role,active,division,site,created_at) VALUES(?,?,?,?,1,?,?,?)',
                (DEFAULT_ADMIN_USER,'Administrator',hash_password(DEFAULT_ADMIN_PASSWORD),'Administrator','FMT','TBS',now()))


def cleanup_sessions():
    execute('DELETE FROM sessions WHERE expires_at<=?',(now(),))


def create_session(user_id: int) -> str:
    cleanup_sessions(); token=secrets.token_urlsafe(48)
    exp=(datetime.now()+timedelta(hours=SESSION_HOURS)).isoformat(timespec='seconds')
    execute('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)',(token,user_id,exp)); return token


def delete_session(token: str|None):
    if token: execute('DELETE FROM sessions WHERE token=?',(token,))


def current_user(request: Request):
    token=request.cookies.get(COOKIE)
    if not token: return None
    return q('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1',(token,now()),one=True)


def require_user(request: Request):
    u=current_user(request)
    if not u: raise HTTPException(401)
    return u

LEGACY = {
    'view': {'dashboard.view','attendance.view','asset.view','tools.view','consumable.view','change.view','report.view'},
    'create': {'attendance.upload','asset.create','tools.create','consumable.create','change.create','incident.create','problem.create'},
    'edit': {'attendance.review','asset.edit','tools.edit','consumable.edit','change.edit','incident.edit','problem.edit'},
    'delete': {'admin'}, 'approve': {'attendance.sign','change.approve'}, 'import': {'asset.import','tools.import','consumable.edit'},
    'export': {'attendance.download','asset.export','tools.export','consumable.export','report.export'}, 'admin': {'admin'}
}


def can(user, permission: str) -> bool:
    if not user: return False
    if user['role']=='Administrator': return True
    if permission=='admin': return False
    # Explicit user override wins.
    r=q('SELECT allowed FROM user_permissions WHERE user_id=? AND permission=?',(user['id'],permission),one=True)
    if r is not None: return bool(r['allowed'])
    if permission in LEGACY:
        return any(can(user,p) for p in LEGACY[permission])
    if q("SELECT 1 FROM role_permissions WHERE role=? AND permission='*'",(user['role'],),one=True): return True
    return bool(q('SELECT 1 FROM role_permissions WHERE role=? AND permission=?',(user['role'],permission),one=True))
