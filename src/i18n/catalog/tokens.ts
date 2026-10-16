import { defineMessages } from "../define";

// Settings → Token saver (src/views/settings/TokenSaverSettings.tsx). Columns: en, fr.
export default defineMessages({
  "tokens.title": ["Token saver", "Économie de tokens"],
  "tokens.subtitle": [
    "Most of the spend used to come right after NEXUS (re)started: every agent's session was resumed, re-cached its whole conversation and spent a turn on a recovery note.",
    "L'essentiel de la dépense venait juste après un (re)démarrage de NEXUS : chaque session d'agent était reprise, remettait en cache toute sa conversation et dépensait un tour sur une note de reprise.",
  ],
  "tokens.lazyWake": ["Keep agents asleep after a restart", "Garder les agents endormis après un redémarrage"],
  "tokens.lazyWakeHint": [
    "Only Central resumes, and only if a mission was running. The others keep their session and receive their recovery brief with their next real message or task.",
    "Seul Central reprend, et seulement si une mission tournait. Les autres gardent leur session et reçoivent leur brief de reprise avec leur prochain vrai message ou tâche.",
  ],
  "tokens.fresh": ["Start a fresh session above", "Repartir sur une session neuve au-delà de"],
  "tokens.freshHint": [
    "An agent whose last context exceeded this size restarts in a new Claude Code session with a compact handoff brief instead of reloading its whole conversation.",
    "Un agent dont le dernier contexte dépassait cette taille redémarre dans une nouvelle session Claude Code avec un brief de passation compact, au lieu de recharger toute sa conversation.",
  ],
  "tokens.never": ["Never (always resume)", "Jamais (toujours reprendre)"],
  "tokens.k": ["{count}k tokens", "{count}k tokens"],
  "tokens.agentsTitle": ["Agents", "Agents"],
  "tokens.context": ["Last context", "Dernier contexte"],
  "tokens.next": ["Next start", "Prochain démarrage"],
  "tokens.unknown": ["unknown", "inconnu"],
  "tokens.resume": ["resumes its conversation", "reprend sa conversation"],
  "tokens.freshNext": ["fresh session + brief", "session neuve + brief"],
  "tokens.noSession": ["new session", "nouvelle session"],
  "tokens.opusHint": [
    "{count} worker(s) run on Opus. Sonnet costs about half as much per token (list prices in AI Usage); set the model per agent in Models.",
    "{count} worker(s) tournent sur Opus. Sonnet coûte environ deux fois moins par token (prix catalogue dans Utilisation IA) ; le modèle se règle par agent dans Modèles.",
  ],
});
