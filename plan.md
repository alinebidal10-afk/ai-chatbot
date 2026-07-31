# ai-chatbot — Proje Planı

Son güncelleme: 31 Temmuz 2026

## Özet

Anthropic API üzerine kurulu, akış (SSE) destekli sohbet uygulaması. Next.js 16 +
TypeScript + Tailwind v4; Prisma 7 + libSQL (yerelde `dev.db`, production'da
Turso); model erişimi Claude Opus 5 / Sonnet 5 / Haiku 4.5. Dört yerleşik araç:
haber (RSS), LinkedIn profili (Scrapin + Anthropic web search), YouTube özeti
(youtubei.js + parçalı özetleme), hava durumu (Open-Meteo). Maskot: alfa kanallı
webm, video saatine kilitli kare-başına ofset tablosuyla bar'a oturuyor.

- Canlı site: https://ai-chatbot-li-flows.vercel.app
- Repo: https://github.com/alinebidal10-afk/ai-chatbot
- Vercel paneli: https://vercel.com/li-flows/ai-chatbot

## Mimari (kısa)

| Katman | Teknoloji |
|---|---|
| UI | `components/` — Chat, Composer (pill bar), Sidebar, Mascot, MessageList |
| API | `app/api/chat` (SSE + araç döngüsü, maks 6 tur), `app/api/conversations` |
| Modeller | `lib/providers/anthropic.ts` — Opus 5 varsayılan; başlıklar Haiku 4.5 |
| Araçlar | `lib/tools/` — news, linkedin (ProfileProvider adaptörü), youtube, weather |
| Veri | Prisma 7 + `@prisma/adapter-libsql`; şema `prisma/schema.prisma` |
| Tipografi | Cause değişken font (`app/fonts.ts`), tek aile, maks ağırlık 500 |

## Tamamlananlar

- [x] Çekirdek uygulama: akışlı sohbet, kalıcı geçmiş, model seçici, görsel ekleme
- [x] 11 değişiklik istemi uygulandı ve tarayıcıda doğrulandı (yerleşim, sidebar,
      maskot geometrisi/davranışı, tipografi, araçlar) — ayrıntılar git geçmişinde
- [x] Otomatik sohbet başlıkları (Haiku, ilk mesajdan hemen sonra, 40 karakter fallback)
- [x] LinkedIn: Scrapin (ReverseContact V2) sağlayıcısı + Anthropic web search
      yedeği; kaynak etiketi ve profil URL'siyle raporlama; asla uydurma yok
- [x] YouTube: gerçek transkript (ANDROID istemci yedeğiyle), 6000 karakterlik
      parçalarla map-reduce özetleme, dürüst "altyazı yok" yolu
- [x] Hava durumu: geocode + 3 günlük tahmin, WMO kod çevirisi, SF/NYC kısaltmaları
- [x] Vercel production deploy (li-flows/ai-chatbot) + GitHub reposu
- [x] Prisma libSQL adaptörü — yerel dosya DB'si ile Turso'ya tek kod yolu
- [x] Mobil uyum (değişiklik istemi 12): safe-area + dvh, klavye açılınca
      visualViewport ile bar kaldırma ve maskot gizleme, duyarlı maskot
      boyutları (280/220/180), scrim'li sidebar + seçimde otomatik kapanma,
      44px dokunma hedefleri, 16px giriş yazısı (iOS zoom engeli)

## Açık işler (öncelik sırasıyla)

1. **Deployment Protection'ı kapat** — site şu an yalnızca takım üyelerine açık
   (302 → SSO). Vercel paneli → Settings → Deployment Protection → Vercel
   Authentication → Disabled. *(Dashboard erişimi gerektirir — kullanıcı adımı)*
2. **Turso veritabanı** — production'da sohbet geçmişi için gerekli; şu an DB
   uçları prod'da çalışmaz. `turso auth signup` sonrası: DB oluştur, şemayı uygula
   (`npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`),
   `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`'ı Vercel env'e ekle, yeniden deploy.
3. **GitHub ↔ Vercel bağlantısı** — push'ta otomatik deploy için hesapta GitHub
   Login Connection kurulmalı (Settings → Git). O zamana dek deploy: `npx vercel --prod`.
4. **Kalan canlı doğrulamalar** — görsel ekleme ve model değiştirme akışları
   production anahtaryla uçtan uca test edilmedi (araçlar ve akış test edildi).
5. *(Opsiyonel)* **Apollo anahtarı** — LinkedIn'de ikinci sağlayıcı olarak hazır
   (`APOLLO_API_KEY`); Scrapin deneme kredisi (~96 kaldı) bitince alternatif.

## İyileştirme fikirleri (sonrası için)

- Sohbet arama sonuçlarında eşleşen mesaj parçasını gösterme (şimdi yalnız başlık listesi)
- Mesaj düzenleme / yeniden üretme (regenerate) düğmeleri
- Maskot için `prefers-reduced-motion` dışında el ile kapatma ayarı
- Oran sınırlama ve basit kötüye kullanım koruması (public site için)
- Vercel Analytics / hata izleme

## Komutlar

```bash
npm run dev          # yerel geliştirme (http://localhost:3006 için: npx next dev -p 3006)
npm run build        # prisma generate + next build
npx vercel --prod    # production deploy
npx vercel ls        # deploy durumu
```

Ortam değişkenleri: `.env.local` — `ANTHROPIC_API_KEY` (zorunlu),
`SCRAPIN_API_KEY` (LinkedIn), `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`
(production DB), `APOLLO_API_KEY` (opsiyonel).
