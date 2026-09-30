export function LoadingSkeleton() {
  return (
    <div className="stack" aria-busy="true" aria-label="Envanter yükleniyor">
      <div className="card panel">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton" style={{ height: 18 }} />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ project, principal, partial }: { project: string; principal: string | null; partial: boolean }) {
  return (
    <section className="card panel empty">
      <h2>{partial ? 'Okunabilen zone\'larda VM yok' : 'Bu projede VM yok'}</h2>
      <p>
        {partial
          ? 'Bazı zone\'lar okunamadığı için liste eksik olabilir; ayrıntı yukarıdaki uyarıda.'
          : `Bağlantı ve yetki doğrulandı: ${principal ?? 'servis kimliği'} ile ${project} projesinin tüm zone'ları tarandı, hiç VM bulunamadı. Bu bir hata değil.`}
      </p>
      <p className="muted">Yeni oluşturulan bir VM birkaç saniye içinde görünür; Yenile ile tekrar tarayabilirsiniz.</p>
    </section>
  );
}
