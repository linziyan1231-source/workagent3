package sharedtrash

import (
	"context"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"

	"workagent3/internal/winutil"
)

// Metadata precedes filesystem moves. Pending phases let a service restart
// finish ACL projection without losing a moved payload or exposing stale ACLs.
func (s *Store) recover(ctx context.Context) error {
	projects, err := os.ReadDir(s.root)
	if err != nil {
		return err
	}
	var failures []error
	for _, project := range projects {
		if !project.IsDir() || !projectPattern.MatchString(project.Name()) {
			continue
		}
		root := filepath.Join(s.root, project.Name())
		if err := normalDirectory(root); err != nil {
			if errors.Is(err, ErrInvalid) {
				continue
			}
			return err
		}
		items, err := os.ReadDir(root)
		if err != nil {
			return err
		}
		for _, item := range items {
			if err := ctx.Err(); err != nil {
				return err
			}
			if !item.IsDir() || !entryPattern.MatchString(item.Name()) {
				continue
			}
			directory := filepath.Join(root, item.Name())
			record, err := readMetadata(directory, project.Name(), item.Name())
			if errors.Is(err, ErrInvalid) || errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				log.Printf("Shared trash recovery preserved unreadable entry %s/%s: %v", project.Name(), item.Name(), err)
				continue
			}
			if record.Order > s.order {
				s.order = record.Order
			}
			if record.Phase == "" {
				continue
			}
			if err := s.recoverRecord(directory, record); err != nil {
				failures = append(failures, err)
			}
		}
	}
	return errors.Join(failures...)
}

func (s *Store) recoverRecord(directory string, record metadata) error {
	if record.Phase == "purging" {
		return finishPurge(directory)
	}
	if record.Phase != "recycling" && record.Phase != "restoring" {
		return nil
	}
	payload := filepath.Join(directory, "payload")
	_, _, payloadErr := treeSize(payload)
	if payloadErr == nil {
		if err := winutil.ProtectSharedTrashTree(payload); err != nil {
			return err
		}
		_, size, err := treeSize(payload)
		if err != nil {
			return err
		}
		record.Size, record.Phase = size, ""
		return writeMetadata(directory, record)
	}
	if !errors.Is(payloadErr, fs.ErrNotExist) {
		return payloadErr
	}
	if record.Phase == "restoring" {
		projectRoot, err := s.currentProjectRoot(record.ProjectID)
		if err != nil {
			return err
		}
		target, err := safePath(projectRoot, record.Path, false)
		if err != nil {
			return err
		}
		if err := winutil.RestoreSharedTrashTree(target, projectRoot); err != nil {
			return err
		}
	}
	return removeEmptyRecord(directory)
}

func removeEmptyRecord(directory string) error {
	if _, err := os.Lstat(filepath.Join(directory, "payload")); !errors.Is(err, fs.ErrNotExist) {
		if err != nil {
			return err
		}
		return ErrInvalid
	}
	if err := os.Remove(filepath.Join(directory, "metadata.json")); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.Remove(directory)
}

func (s *Store) currentProjectRoot(projectID string) (string, error) {
	sharedRoot := filepath.Join(s.base, "shared")
	if err := normalDirectory(sharedRoot); err != nil {
		return "", err
	}
	owners, err := os.ReadDir(sharedRoot)
	if err != nil {
		return "", err
	}
	result := ""
	for _, owner := range owners {
		if !owner.IsDir() || !sidPattern.MatchString(owner.Name()) {
			continue
		}
		root, err := s.projectRoot(projectID, owner.Name())
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if result != "" {
			return "", ErrInvalid
		}
		result = root
	}
	if result == "" {
		return "", fs.ErrNotExist
	}
	return result, nil
}
