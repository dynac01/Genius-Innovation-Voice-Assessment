# syntax=docker/dockerfile:1

# One container, one origin. The server serves the built browser app and the
# WebSocket together — a second origin would make the socket cross-origin and put
# the demo one CORS or cookie policy away from failing on the mobile browsers it
# most needs to work on.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable

# Manifests first, so a source-only change does not re-resolve the dependency
# graph. The lockfile is frozen: a build that silently resolved different
# versions than CI tested is not the build we tested.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/providers/package.json packages/providers/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @voice/web build

# Runtime keeps the workspace layout rather than bundling. Internal packages are
# consumed as TypeScript source and run under tsx, which is the same code path as
# development — for a proof of concept, one code path beats a faster cold start.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./

# tsconfig.base.json, because every package's tsconfig extends it and the server
# runs from TypeScript source under tsx.
#
# Leaving it out does not degrade gracefully: esbuild cannot resolve the `extends`,
# discards the *whole* config rather than just the inherited half, and so loses
# `experimentalDecorators` — which is declared directly in the server's own tsconfig
# and would look impossible to lose. The container then built cleanly and died on
# boot with "Parameter decorators only work when experimental decorators are
# enabled", pointing at a setting that is plainly present.
#
# Caught by the container smoke test in CI, which is the second time that job has
# earned its place — the first was pnpm not hoisting tsx.
COPY --from=build /app/tsconfig.base.json ./

# Never runs as root: the process handles untrusted input from every visitor.
USER node

ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Started through pnpm rather than `node --import tsx`, and from the package
# directory rather than the workspace root. pnpm does not hoist, so `tsx` lives in
# apps/server/node_modules and is not resolvable from /app — the container built
# fine and then failed to boot, which is exactly the class of problem the CI
# smoke test exists to catch. Going through the workspace script also means
# production runs the same command as development.
CMD ["pnpm", "--filter", "@voice/server", "start"]
