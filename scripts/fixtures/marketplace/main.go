// Seed a disposable skill package for smoke-dsh-experience.mjs.
// Usage: marketplace-fixture <market-db> <entry-id> <publisher> [remove]
package main

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"os"
	"workagent3/internal/marketplace"
)

func main() {
	if len(os.Args) < 4 {
		panic("usage: marketplace-fixture <market-db> <entry-id> <publisher> [remove]")
	}
	s, err := marketplace.Open(os.Args[1])
	must(err)
	defer s.Close()
	id, publisher := os.Args[2], os.Args[3]
	if len(os.Args) > 4 && os.Args[4] == "remove" {
		must(s.Unpublish(context.Background(), id, publisher))
		return
	}
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	f, err := z.Create("SKILL.md")
	must(err)
	_, err = f.Write([]byte("---\nname: smoke-market-writing\ndescription: Market bundle acceptance fixture\n---\n\nUse this skill only for the market acceptance check.\n"))
	must(err)
	must(z.Close())
	must(s.Publish(context.Background(), marketplace.Entry{ID: id, Kind: "skill", Name: "市场验收技能", Description: "仅用于验证依赖安装，验收后下架。", Version: "1.0.0", Publisher: publisher}, marketplace.Bundle{Skills: []marketplace.Skill{{ID: "seed-writing", Name: "smoke-market-writing", Description: "Market bundle acceptance fixture", Version: "1.0.0", Archive: buf.Bytes()}}, MCP: []marketplace.Connector{}}))
	fmt.Println("FIXTURE_READY")
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
