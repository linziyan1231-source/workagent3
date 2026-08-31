import { Spin } from "@arco-design/web-react";

/** Browser-hosted copy of the formal Renderer AppLoader. */
export default function AppLoader() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
      }}
    >
      <Spin dot />
    </div>
  );
}
