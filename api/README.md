# Nebula API - Hono + PostgreSQL

API simple avec Hono et connexion PostgreSQL pour Docker Swarm.

## Endpoints

- `GET /` - Message de bienvenue
- `GET /health` - Health check avec test de connexion DB
- `GET /test-query` - Test de requête PostgreSQL (version)

## Développement local

```bash
cd api
npm install
npm run dev
```

## Build et déploiement Swarm

```bash
# Build l'image
docker build -t nebula-api:latest ./api

# Déployer le stack
docker stack deploy -c nebula.yml nebula
```

## Variables d'environnement

- `DB_HOST` - Hôte PostgreSQL (default: postgres-primary)
- `DB_PORT` - Port PostgreSQL (default: 5432)
- `DB_NAME` - Nom de la base (default: nebula)
- `DB_USER` - Utilisateur DB (default: nebula)
- `DB_PASSWORD` - Mot de passe DB (default: nebula_pass)
- `PORT` - Port de l'API (default: 3000)
