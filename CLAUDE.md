@AGENTS.md

## Deploy Configuration (configured by /setup-deploy)
- Platform: Vercel (team: li-flows, project: ai-chatbot)
- Production URL: https://ai-chatbot-li-flows.vercel.app
- Deploy workflow: `npx vercel --prod` from local (GitHub auto-deploy pending Login Connection on the Vercel account)
- Deploy status command: `npx vercel ls`
- Merge method: fast-forward merge to main, then deploy
- Project type: web app (Next.js 16 + Prisma/libSQL)
- Post-deploy health check: `curl -s -o /dev/null -w "%{http_code}" https://ai-chatbot-li-flows.vercel.app` (expect 200; 302 = deployment protection still enabled)

### Custom deploy hooks
- Pre-merge: `npm run build` (runs prisma generate + next build)
- Deploy trigger: `npx vercel --prod --yes` (or push to main once GitHub is connected in Vercel)
- Deploy status: `npx vercel ls`
- Health check: https://ai-chatbot-li-flows.vercel.app
- DB: Turso (libSQL) via TURSO_DATABASE_URL + TURSO_AUTH_TOKEN env vars; local dev falls back to file:./dev.db. Schema DDL: `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
