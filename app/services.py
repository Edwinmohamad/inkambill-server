from __future__ import annotations
from pathlib import Path
from uuid import uuid4
import os, hashlib, json
from fastapi import UploadFile, HTTPException
from openpyxl import load_workbook, Workbook
from .db import q, execute, now, BASE

ALLOWED_IMAGE = {'.jpg','.jpeg','.png','.webp'}
ALLOWED_TICKET = {'.pdf','.xlsx','.xls','.docx','.jpg','.jpeg','.png','.webp'}
MAX_UPLOAD_MB = int(os.getenv('FMT_MAX_UPLOAD_MB', '25'))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

def save_upload(file: UploadFile, folder: str, allowed: set[str]) -> tuple[str,str]:
    ext = Path(file.filename or '').suffix.lower()
    if ext not in allowed:
        raise HTTPException(400, f"File type {ext or 'unknown'} is not allowed")
    rel_dir = Path('uploads') / folder
    abs_dir = BASE / rel_dir
    abs_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid4().hex}{ext}"
    target = abs_dir / name
    written = 0
    try:
        with target.open('wb') as out:
            while True:
                chunk = file.file.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"File is too large. Maximum upload size is {MAX_UPLOAD_MB} MB")
                out.write(chunk)
        if written == 0:
            raise HTTPException(400, "Uploaded file is empty")
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return str((rel_dir / name).as_posix()), file.filename or name

def preview_inventory_xlsx(path: Path):
    try:
        wb=load_workbook(path,data_only=True,read_only=True)
    except Exception as exc:
        raise HTTPException(400,f"Excel file could not be read: {exc}")
    ws=wb.active
    rows=list(ws.iter_rows(min_row=1,max_row=11,values_only=True))
    if not rows:
        wb.close(); raise HTTPException(400,'Excel file is empty')
    headers=[str(v).strip() if v is not None else '' for v in rows[0]]
    if not any(headers):
        wb.close(); raise HTTPException(400,'Excel header row is empty')
    sample=[["" if v is None else str(v) for v in row] for row in rows[1:]]
    total=max((ws.max_row or 1)-1,0)
    wb.close()
    return {'headers':headers,'sample':sample,'total_rows':total}

def inventory_import_xlsx(path: Path, table: str, id_col: str, name_col: str, mapping: dict[str,str] | None = None):
    try:
        wb = load_workbook(path, data_only=True, read_only=True)
    except Exception as exc:
        raise HTTPException(400, f"Excel file could not be read: {exc}")
    ws = wb.active
    first = next(ws.iter_rows(min_row=1, max_row=1, values_only=True), ())
    headers = [str(v).strip() if v is not None else '' for v in first]
    normalized = {h.lower().replace(' ','_'): i for i,h in enumerate(headers)}
    mapping = mapping or {}
    aliases = {
      id_col: [id_col, id_col.replace('_',' '), 'id'],
      name_col: [name_col, name_col.replace('_',' '), 'name'],
    }
    def idx(key):
        if mapping.get(key):
            mk=mapping[key].lower().replace(' ','_')
            return normalized.get(mk)
        for a in aliases.get(key,[key]):
            k=a.lower().replace(' ','_')
            if k in normalized: return normalized[k]
        return None
    i_id, i_name = idx(id_col), idx(name_col)
    if i_id is None or i_name is None:
        raise HTTPException(400, f"Required columns are missing: {id_col}, {name_col}")
    fields = {
      'assets':['asset_id','asset_name','category','brand','serial_number','location','pic','condition','status','notes'],
      'tools':['tool_id','tool_name','category','brand','serial_number','location','pic','condition','status','notes'],
      'consumables':['item_id','item_name','category','unit','location','current_stock','minimum_stock','notes'],
    }[table]
    created=updated=skipped=failed=0
    errors=[]
    for rno,row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        ident = row[i_id] if i_id < len(row) else None
        name = row[i_name] if i_name < len(row) else None
        if ident is None or name is None or not str(ident).strip() or not str(name).strip():
            skipped += 1; continue
        data={}
        for f in fields:
            source=mapping.get(f,f)
            j=normalized.get(source.lower().replace(' ','_'))
            data[f] = row[j] if j is not None and j < len(row) else None
        data[id_col]=str(ident).strip(); data[name_col]=str(name).strip()
        try:
            exists=q(f"SELECT id FROM {table} WHERE {id_col}=?", (data[id_col],), one=True)
            ts=now()
            if table=='consumables':
                for n in ('current_stock','minimum_stock'):
                    try: data[n]=float(data[n] or 0)
                    except (ValueError, TypeError): data[n]=0
                if data['current_stock'] < 0 or data['minimum_stock'] < 0:
                    raise ValueError('Stock values cannot be negative')
            if exists:
                cols=[f for f in fields if f!=id_col]
                # Current stock is transaction controlled; imports do not silently overwrite it.
                if table == 'consumables':
                    cols=[f for f in cols if f != 'current_stock']
                vals=[data.get(f) for f in cols] + [ts, data[id_col]]
                execute(f"UPDATE {table} SET "+','.join(f"{c}=?" for c in cols)+",updated_at=? WHERE "+id_col+"=?", vals)
                updated+=1
            else:
                cols=fields+['created_at','updated_at']
                vals=[data.get(f) for f in fields]+[ts,ts]
                execute(f"INSERT INTO {table}("+','.join(cols)+") VALUES("+','.join('?'*len(cols))+")", vals)
                created+=1
        except Exception as e:
            failed+=1; errors.append({'row':rno,'error':str(e)})
    wb.close()
    return {'total':created+updated+skipped+failed,'created':created,'updated':updated,'skipped':skipped,'failed':failed,'errors':errors[:100]}

def export_inventory_xlsx(table: str, fields: list[str], labels: list[str]):
    wb=Workbook(); ws=wb.active; ws.title=table.title(); ws.append(labels)
    for r in q(f"SELECT {','.join(fields)} FROM {table} ORDER BY id DESC"):
        ws.append([r[f] for f in fields])
    ws.freeze_panes='A2'; ws.auto_filter.ref=ws.dimensions
    return wb

TICKET_TRANSITIONS = {
 'Draft': {'Open','Cancelled'},
 'Open': {'Waiting Approval','Cancelled'},
 'Waiting Approval': {'Approved','Rejected','Revision Required'},
 'Revision Required': {'Waiting Approval','Cancelled'},
 'Rejected': {'Revision Required','Cancelled'},
 'Approved': {'In Progress','Cancelled'},
 'In Progress': {'Resolved','On Hold'},
 'On Hold': {'In Progress','Cancelled'},
 'Resolved': {'Closed','In Progress'},
 'Closed': set(), 'Cancelled': set(),
}
ATTENDANCE_TRANSITIONS = {
 'Uploaded': {'Checking','Ready to Sign'},
 'Checking': {'Need Revision','Ready to Sign','Ready for Approval'},
 'Need Revision': {'Checking'},
 'Ready to Sign': {'Checking'},
 'Signed': {'Final'},
 'Final': {'Archived'},
 'Ready for Approval': {'Waiting Approval','Ready to Sign'},
 'Waiting Approval': {'Approved','Need Revision','Rejected'},
 'Rejected': {'Need Revision'},
 'Approved': {'Archived'},
 'Archived': set(),
}

def allowed_attendance_transitions(user, current: str) -> list[str]:
    all_next = ATTENDANCE_TRANSITIONS.get(current, set())
    role = user['role']
    if role == 'Administrator': return sorted(all_next)
    if role == 'Approver':
        return sorted(all_next & {'Approved','Rejected','Need Revision','Ready to Sign','Final'})
    if role == 'Staff':
        return sorted(all_next & {'Checking','Need Revision','Ready for Approval','Waiting Approval','Ready to Sign','Archived'})
    return []

def allowed_ticket_transitions(user, current: str) -> list[str]:
    all_next = TICKET_TRANSITIONS.get(current, set())
    role = user['role']
    if role == 'Administrator': return sorted(all_next)
    if role == 'Approver': return sorted(all_next & {'Approved','Rejected','Revision Required'})
    if role == 'Staff': return sorted(all_next - {'Approved','Rejected'})
    return []

# ---------------- PDF signing / image validation ----------------
import hashlib, mimetypes
from io import BytesIO
import fitz
from PIL import Image


def sha256_file(path: Path) -> str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()


def validate_image_file(path: Path) -> str:
    try:
        with Image.open(path) as im:
            fmt=(im.format or '').upper()
            im.verify()
    except Exception as exc:
        raise HTTPException(400,f'Image file is invalid: {exc}')
    return {'PNG':'image/png','JPEG':'image/jpeg','WEBP':'image/webp'}.get(fmt,'application/octet-stream')


def save_image_upload(file: UploadFile, folder: str) -> tuple[str,str,str]:
    # Permit .logo because the user's BDX logo may use that custom extension; content is still verified as an image.
    ext=Path(file.filename or '').suffix.lower()
    if ext not in ALLOWED_IMAGE|{'.logo'}:
        raise HTTPException(400,'Image must be PNG, JPG, JPEG, WEBP or .logo containing a supported image')
    rel,orig=save_upload(file,folder,ALLOWED_IMAGE|{'.logo'})
    p=BASE/rel
    try: media=validate_image_file(p)
    except Exception:
        p.unlink(missing_ok=True); raise
    return rel,orig,media


def pdf_info(path: Path) -> dict:
    try:
        doc=fitz.open(path)
        if doc.needs_pass:
            raise HTTPException(400,'Password-protected PDF is not supported')
        if doc.page_count < 1: raise HTTPException(400,'PDF contains no pages')
        pages=[]
        for i in range(doc.page_count):
            p=doc[i]; r=p.rect
            pages.append({'page':i+1,'width':float(r.width),'height':float(r.height),'rotation':int(p.rotation)})
        out={'page_count':doc.page_count,'pages':pages,'width':pages[0]['width'],'height':pages[0]['height']}
        doc.close(); return out
    except HTTPException: raise
    except Exception as exc:
        raise HTTPException(400,f'PDF could not be read: {exc}')


def pdf_layout_fingerprint(info: dict) -> str:
    payload=[{"w":round(float(p["width"]),2),"h":round(float(p["height"]),2),"r":int(p.get("rotation",0))} for p in info.get("pages",[])]
    return hashlib.sha256(json.dumps(payload,separators=(",",":"),sort_keys=True).encode()).hexdigest()[:24]


def _placement_rect(page, pl: dict):
    dr=page.rect
    rr=fitz.Rect(float(pl['nx'])*dr.width,float(pl['ny'])*dr.height,(float(pl['nx'])+float(pl['nw']))*dr.width,(float(pl['ny'])+float(pl['nh']))*dr.height)
    if page.rotation:
        rr=rr * page.derotation_matrix
    return rr


def verify_signature_regions(original: Path, signed: Path, placements: list[dict]):
    """Verify every expected signature region is visually changed in the signed PDF."""
    src=fitz.open(original); out=fitz.open(signed)
    try:
        if src.page_count != out.page_count:
            raise HTTPException(500,'Signed PDF page count verification failed')
        for pl in placements:
            page_no=int(pl['page'])
            if page_no<1 or page_no>src.page_count:
                raise HTTPException(500,'Signature verification page is invalid')
            sp=src[page_no-1]; op=out[page_no-1]; rr=_placement_rect(sp,pl)
            a=sp.get_pixmap(matrix=fitz.Matrix(1.5,1.5),clip=rr,alpha=False)
            b=op.get_pixmap(matrix=fitz.Matrix(1.5,1.5),clip=rr,alpha=False)
            if a.width!=b.width or a.height!=b.height or a.n!=b.n:
                continue
            sa=a.samples; sb=b.samples
            if len(sa)==0 or len(sb)==0:
                raise HTTPException(500,'Signature visual verification produced an empty region')
            changed=sum(1 for x,y in zip(sa,sb) if x!=y)
            threshold=max(24,int(len(sa)*0.002))
            if changed < threshold:
                raise HTTPException(500,f'Signature visual verification failed on page {page_no}')
    finally:
        src.close(); out.close()


def render_pdf_page(path: Path, page_no: int, zoom: float=1.5, placements: list[dict]|None=None, signature_paths: dict[int,Path]|None=None) -> bytes:
    doc=fitz.open(path)
    try:
        if page_no<1 or page_no>doc.page_count: raise HTTPException(404,'PDF page not found')
        page=doc[page_no-1]
        if placements:
            for pl in placements:
                if int(pl['page'])!=page_no: continue
                sigp=(signature_paths or {}).get(int(pl['signature_id']))
                if not sigp or not sigp.is_file(): continue
                rr=_placement_rect(page,pl)
                page.insert_image(rr,filename=str(sigp),keep_proportion=True,overlay=True)
        pix=page.get_pixmap(matrix=fitz.Matrix(zoom,zoom),alpha=False)
        return pix.tobytes('png')
    finally: doc.close()


def validate_normalized_placement(pl: dict):
    vals=[float(pl[k]) for k in ('nx','ny','nw','nh')]
    nx,ny,nw,nh=vals
    if nw<=0 or nh<=0 or nx<0 or ny<0 or nx+nw>1.000001 or ny+nh>1.000001:
        raise HTTPException(400,'Signature box is outside the PDF page')
    if nw<0.015 or nh<0.01:
        raise HTTPException(400,'Signature box is too small')


def sign_pdf(original: Path, output: Path, placements: list[dict], signature_paths: dict[int,Path]) -> dict:
    if not placements: raise HTTPException(400,'No signature placement is configured')
    doc=fitz.open(original)
    try:
        if doc.needs_pass: raise HTTPException(400,'Password-protected PDF is not supported')
        for pl in placements:
            validate_normalized_placement(pl)
            page_no=int(pl['page'])
            if page_no<1 or page_no>doc.page_count: raise HTTPException(400,f'Invalid signature page {page_no}')
            sigp=signature_paths.get(int(pl['signature_id']))
            if not sigp or not sigp.is_file(): raise HTTPException(400,'Signature image is missing')
            page=doc[page_no-1]
            rr=_placement_rect(page,pl)
            page.insert_image(rr,filename=str(sigp),keep_proportion=True,overlay=True)
        output.parent.mkdir(parents=True,exist_ok=True)
        tmp=output.with_suffix('.tmp.pdf')
        doc.save(tmp,garbage=4,deflate=True)
        tmp.replace(output)
    finally: doc.close()
    # Verification: file integrity + page count + visible change inside every signature box.
    if not output.is_file() or output.stat().st_size<100: raise HTTPException(500,'Signed PDF output is invalid')
    verify_signature_regions(original,output,placements)
    return {'checksum':sha256_file(output),'size':output.stat().st_size}
