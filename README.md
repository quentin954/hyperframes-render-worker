# hyperframes-render-worker

Serveur de rendu HyperFrames sur un serveur. Le client envoie un dossier de
composition, reçoit un `jobId`, puis récupère le MP4 sur `GET /jobs/:id/output` une
fois le rendu terminé en arrière-plan.

## Architecture

```
   client
     │  POST   /jobs            → 202 { jobId }
     │  GET    /jobs            → liste
     │  GET    /jobs/:id        → statut, progression
     │  GET    /jobs/:id/output → video/mp4
     │  DELETE /jobs/:id        → annuler et purger
     │  GET    /queue           → file
     ▼
┌───────────────────────────────────────────────┐
│  conteneur : serveur node                     │
│                                               │
│  état en mémoire, seule source de vérité      │
│    jobs      Map, tous les jobs connus        │
│    pending   file d'attente, ordonnés         │
│    running   un seul job rendu à la fois      │
│                                               │
│    └──▶ executeRenderJob()                    │
│           └─ chrome + ffmpeg                  │
│                                               │
│  $DATA_DIR/jobs/<jobId>/                      │
│    job.json    écrit en tmp puis rename       │
│    project/    la composition reçue           │
│    output.mp4  le rendu                       │
│                                               │
│  le disque est un miroir, pas la source       │
└───────────────────────────────────────────────┘
         ▲
         │  au démarrage : relit les job.json, recharge la Map,
         │  et marque failed les jobs trouvés en cours
```

## Build

```bash
docker build -t hf-worker .
```

## Lancer

Le volume d'abord, sinon Docker en crée un anonyme et le volume nommé reste
inutilisé.

```bash
docker volume create hf-data
```

```bash
docker run -d \
  --name hf-worker \
  --rm \
  -p 11111:8080 \
  -v hf-data:/data \
  -e HF_CAPTURE_PARALLEL_STREAM=true \
  -e PRODUCER_ENABLE_STREAMING_ENCODE=true \
  -e PRODUCER_STREAMING_ENCODE_DURATION_CAP_ENABLED=false \
  hf-worker
```

Le volume est ce qui garde les rendus. Sans lui, ils disparaissent avec le
conteneur. Pour les lire directement depuis l'hôte, monte un dossier à la place :

```bash
-v /opt/hyperframes/data:/data
```

Vérifier que ça répond :

```bash
curl -s localhost:11111/healthz   # ok
curl -s localhost:11111/queue     # file en cours
```

## Configuration

| variable | défaut | rôle |
|---|---|---|
| `PORT` | `8080` | port d'écoute |
| `DATA_DIR` | `/data` | racine des jobs |
| `RENDER_QUALITY` | `standard` | `draft`, `standard` ou `high` |
| `ENTRY_FILE` | `index.html` | composition d'entrée du projet |
| `RENDER_TIMEOUT_MS` | `0` | borne la durée d'un rendu. `0` désactive |

`RENDER_TIMEOUT_MS` vaut 0 par défaut : une composition réelle rend pendant plus
d'une heure, et le renderer signale lui-même ses propres blocages.

Ces trois variables ne sont pas lues par le serveur : c'est le producer qui lit
son propre environnement.

## API

| route | réponse |
|---|---|
| `POST /jobs` | `202` job. Corps : `{ files: [{ path, content }], workers? }`, `content` en base64 |
| `GET /jobs` | `{ count, jobs }`, du plus récent au plus ancien |
| `GET /jobs/:id` | job |
| `GET /jobs/:id/output` | `200 video/mp4`, ou `409` tant que le rendu n'est pas terminé |
| `DELETE /jobs/:id` | `200` purgé, ou `202` si le renderer écrit encore dans le dossier |
| `GET /queue` | `{ running, queued, jobs }` |
| `GET /healthz` | `ok` |

Un job :

```json
{
  "jobId": "29bc5f24-…",
  "status": "rendering",
  "workers": 8,
  "createdAt": 1791380062940,
  "startedAt": 1791380062940,
  "finishedAt": null,
  "elapsedMs": 4213,
  "progress": 25,
  "stage": "Streaming frame 113504/306770 (4 workers)",
  "totalFrames": 306770,
  "capturedFrames": 113504,
  "size": null,
  "error": null
}
```

`status` suit le `RenderStatus` du producer : `queued`, `preprocessing`,
`rendering`, `encoding`, `assembling`, puis `complete`, `failed` ou `cancelled`.
`position` n'apparaît que tant que le job attend, `download` que s'il est
`complete`.

### workers

Un rendu mobilise un Chrome par worker. Le nombre se règle par job :

| valeur | effet | `workers` retourné |
|---|---|---|
| absente | le producer choisit | `null` |
| `1` | séquentiel | `1` |
| `2` à `24` | tel quel, sans calibration | la valeur envoyée |
| `25` ou plus | borné au plafond | `24` |
| `0`, `-1`, `2.5`, `"auto"` | invalide, ignoré | `null` |

## Côté client

Trois scripts, à lancer depuis le poste qui porte la composition.

```bash
node scripts/submit-render.mjs <compositionDir> <output.mp4> [host] [port]
```

Envoie la composition, puis affiche la progression jusqu'au téléchargement :

```
[render] 3 files in cloudflare-intro -> localhost:11111
[render] job b06a661b-… status=rendering workers=auto
[09:44:27] rendering — 60% — 343/540 frames — 15s
[09:44:42] complete — 100% — 540/540 frames — 23s
[render] wrote 1118992 bytes to final.mp4
```

Un job interrupted n'est pas perdu. Plus tard, depuis n'importe quel terminal :

```bash
node scripts/status.mjs <jobId>
node scripts/download.mjs <jobId>
```

| variable | rôle |
|---|---|
| `HF_TEST_HOST` | hôte, sinon `localhost` |
| `HF_TEST_PORT` | port, sinon `11111` |
| `HF_POLL_MS` | intervalle de scrutation, sinon `10000` |
| `HF_WORKERS` | nombre de workers, sinon automatique |

`scripts/render-client.mjs` regroupe le client HTTP partagé par les trois
scripts. Les chemins `.*` et les `.mp4` sont ignorés, les sous-dossiers sont
conservés dans les chemins transmis.
