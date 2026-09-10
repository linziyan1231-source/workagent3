// profile-reference is an administrator deployment utility, not an employee API.
package main

import (
	"flag"
	"fmt"
	"os"
	"workagent3/internal/employee"
)

func main() {
	source := flag.String("source", "", "immutable public Harness profile")
	destination := flag.String("destination", "", "private configuration profile (runtime must be stopped)")
	flag.Parse()
	if *source == "" || *destination == "" {
		flag.Usage()
		os.Exit(2)
	}
	if err := employee.ProjectHarnessProfile(*source, *destination); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
