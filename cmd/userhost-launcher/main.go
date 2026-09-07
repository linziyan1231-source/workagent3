package main

import (
	"flag"
	"log"
	"workagent3/internal/userhostlauncher"
	"workagent3/internal/winutil"
)

func main() {
	path := flag.String("config", "", "administrator-owned launch manifest")
	flag.Parse()
	sid, err := winutil.CurrentSID()
	if err != nil {
		log.Fatal(err)
	}
	manifest, err := userhostlauncher.Load(*path, sid)
	if err != nil {
		log.Fatal(err)
	}
	if err = userhostlauncher.Run(manifest); err != nil {
		log.Fatal(err)
	}
}
