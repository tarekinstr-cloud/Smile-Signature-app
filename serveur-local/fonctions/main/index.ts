// Routeur des fonctions Edge du serveur local : /functions/v1/<nom> → dossier /home/deno/functions/<nom>.
// Version minimale du routeur officiel de Supabase, sans dépendance à télécharger (fonctionne hors ligne).
// La vérification du jeton est faite par chaque fonction (pin-login n'en demande pas : l'écran de connexion n'a
// pas encore de session).

Deno.serve(async (req: Request) => {
  const name = new URL(req.url).pathname.split('/')[1] ?? ''
  if (!/^[a-z0-9_-]+$/i.test(name) || name === 'main') {
    return Response.json({ code: 'NOT_FOUND', message: 'Function not found' }, { status: 404 })
  }
  const servicePath = `/home/deno/functions/${name}`
  try {
    if (!(await Deno.stat(servicePath)).isDirectory) throw new Deno.errors.NotFound()
  } catch {
    return Response.json({ code: 'NOT_FOUND', message: 'Function not found' }, { status: 404 })
  }
  try {
    const envVars = Object.entries(Deno.env.toObject())
    // deno-lint-ignore no-explicit-any
    const worker = await (globalThis as any).EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: 150,
      workerTimeoutMs: 60_000,
      noModuleCache: false,
      envVars,
    })
    return await worker.fetch(req)
  } catch (e) {
    console.error(e)
    return Response.json({ code: 'EDGE_FUNCTION_ERROR', message: String(e) }, { status: 500 })
  }
})
