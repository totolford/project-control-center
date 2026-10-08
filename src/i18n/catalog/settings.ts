import { defineMessages } from "../define";

// Settings page. Columns: en, fr.
export default defineMessages({
  "settings.language.title": ["Language", "Langue"],
  "settings.language.interface": ["Interface language", "Langue de l’interface"],
  "settings.language.interfaceHint": ["Applies to every project on this machine, immediately.", "S’applique à tous les projets de cette machine, immédiatement."],
  "settings.language.world": ["AI World language", "Langue du monde IA"],
  "settings.language.worldHint": ["Text of the AI World. Applies to every project on this machine.", "Textes du monde IA. S’applique à tous les projets de cette machine."],
  "settings.language.projectInterface": ["Interface language for this project", "Langue de l’interface pour ce projet"],
  "settings.language.projectWorld": ["AI World language for this project", "Langue du monde IA pour ce projet"],
  "settings.language.projectHint": ["Stored in .agent-project/settings.json; saved with the project settings.", "Enregistrée dans .agent-project/settings.json, avec les paramètres du projet."],
  "settings.language.auto": ["Auto (system: {name})", "Auto (système : {name})"],
  "settings.language.inherit": ["Same as the app ({name})", "Comme l’application ({name})"],
});
