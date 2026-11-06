// APK INKAMBILL (WebView, HP RAM 4 GB): ratusan kartu sekaligus membuat scroll macet. Untuk permintaan
// dari APK, ukuran halaman bawaan dibatasi; per_page eksplisit tetap dihormati sampai batas maksimum.
const MOBILE_APP_PAGE_SIZE=30;
function isMobileAppRequest(req){const ua=typeof req?.get==='function'?req.get('user-agent'):req?.headers?.['user-agent'];return /INKAMNET-GO\//i.test(String(ua||''));}
function pageInfo(req,defaultSize=50,maxSize=100){
  if(isMobileAppRequest(req))defaultSize=Math.min(defaultSize,MOBILE_APP_PAGE_SIZE);
  const rawPage=Number.parseInt(req.query.page,10),rawSize=Number.parseInt(req.query.per_page,10);
  const page=Number.isSafeInteger(rawPage)&&rawPage>0?rawPage:1;
  const requested=Number.isSafeInteger(rawSize)&&rawSize>0?rawSize:defaultSize;
  const perPage=Math.min(maxSize,Math.max(10,requested));
  return {page,perPage,offset:Math.min(Number.MAX_SAFE_INTEGER,(page-1)*perPage)};
}
async function paginate(db,sql,params,req,defaultSize=50,maxSize=100){const p=pageInfo(req,defaultSize,maxSize);const [[count]]=await db.execute(`SELECT COUNT(*) total FROM (${sql}) paged_source`,params);const total=Number(count.total||0),pages=Math.max(1,Math.ceil(total/p.perPage)),page=Math.min(p.page,pages),offset=(page-1)*p.perPage;const [rows]=await db.execute(`${sql} LIMIT ? OFFSET ?`,[...params,p.perPage,offset]);return {rows,pagination:{page,perPage:p.perPage,total,pages,from:total?offset+1:0,to:Math.min(offset+p.perPage,total)}};}
module.exports={pageInfo,paginate,isMobileAppRequest,MOBILE_APP_PAGE_SIZE};
