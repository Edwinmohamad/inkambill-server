# FMT Operations Dashboard

**Facility Management Division — Site TBS**

Version **3.4.0**

## Flexible signature workflow
The signing workspace supports multiple signature boxes per page, drag/resize, add/remove, exact preview, and master-page synchronization.

### Same signature position on pages 1–5
1. Open page 1.
2. Add, remove, resize and position signatures until correct.
3. In **Apply & lock pages**, enter `2-5`.
4. Click **Save & Lock**.
5. Pages 2–5 are locked to page 1 and automatically use the same layout.
6. Change page 1 later and Save; pages 2–5 update automatically.
7. To make page 3 different, open page 3 and click **Unlock page**. Its existing placement remains but becomes editable independently.

Target syntax supports `2-5`, `2,4,6`, or `2-5,8,10-12`.

## Development checks
```bash
python -m compileall app
node --check app/static/app.js
```

## Docker
```bash
docker compose up -d --build
```
