import { navigation } from "../../host/navigation.js";

const WORKSPACE_PICK_KEY = "workagent.hero.workspace";

const HERO_WORKSPACE_EVENT = "workagent:hero-workspace";

const PROJECTS_CHANGED_EVENT = "workagent:projects-changed";

function startProjectConversation(project) {
  localStorage.setItem(WORKSPACE_PICK_KEY, project.id);
  navigation.navigate(
    `/?frontend=dsh&project=${encodeURIComponent(project.id)}`,
  );
}

const announceProjectsChanged = () =>
  window.dispatchEvent(new window.Event(PROJECTS_CHANGED_EVENT));

export {
  WORKSPACE_PICK_KEY,
  HERO_WORKSPACE_EVENT,
  PROJECTS_CHANGED_EVENT,
  startProjectConversation,
  announceProjectsChanged,
};
