function wantsJson(req){
  const headers=req.headers||{};
  return /^\/api(?:\/|$)/.test(req.originalUrl||req.path||'')||!!req.xhr||/application\/json/i.test(String(headers.accept||'')+' '+String(headers['content-type']||''));
}
function notFound(req,res){
  if(wantsJson(req))return res.status(404).json({ok:false,error:'Halaman atau endpoint tidak ditemukan.'});
  return res.status(404).render('errors/status',{layout:false,status:404,title:'Halaman tidak ditemukan',message:'Alamat yang dibuka tidak tersedia atau sudah dipindahkan.',home:req.session?.user?'/':'/login'});
}
function errorHandler(err,req,res,next){
  console.error(err);
  if(res.headersSent)return next(err);
  const candidate=Number(err.status||err.statusCode),status=Number.isInteger(candidate)&&candidate>=400&&candidate<600?candidate:500;
  const message=status===413?'Ukuran data terlalu besar. Kurangi ukuran lampiran lalu coba lagi.':status===400?'Permintaan tidak valid. Periksa data yang diisi.':'Permintaan belum berhasil diproses. Muat ulang halaman atau coba kembali nanti.';
  if(wantsJson(req))return res.status(status).json({ok:false,error:message});
  return res.status(status).render('errors/status',{layout:false,status,title:'Terjadi kendala',message,home:req.session?.user?'/':'/login'});
}
module.exports={wantsJson,notFound,errorHandler};
