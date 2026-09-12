import { createNavigation } from "./navigation-controller.js";
import React from "react";
import {
  closeMobileSidebar as closeHostSidebar,
  closeSidebar as collapseHostSidebar,
} from "./compatibility.js";

let layout;

function closeMobileSidebar() {
  closeHostSidebar(layout);
}

const navigation = createNavigation(React, closeMobileSidebar);

function closeSidebar() {
  collapseHostSidebar(layout);
}

export { closeMobileSidebar, closeSidebar, navigation };

export function bindLayout(value) {
  layout = value;
}
