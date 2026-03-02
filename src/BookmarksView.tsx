import { NoteThread } from "./NoteCard";
import type { NoteCardActions, NoteCardState } from "./NoteCard";
import type { NostrEvent } from "./types";

export interface BookmarksViewProps {
  notes: NostrEvent[];
  bookmarkIds: Set<string>;
  deletedNoteIds: Set<string>;
  getRepliesTo: (noteId: string) => NostrEvent[];
  state: NoteCardState;
  actions: NoteCardActions;
}

export function BookmarksView({ notes, bookmarkIds, deletedNoteIds, getRepliesTo, state, actions }: BookmarksViewProps) {
  const bookmarkedNotes = notes
    .filter((n) => bookmarkIds.has(n.id) && !deletedNoteIds.has(n.id))
    .sort((a, b) => b.created_at - a.created_at);

  return (
    <section className="bookmarks-view">
      <h2>Bookmarks</h2>
      <p className="muted">Notes you saved (kind 10003).</p>
      <ul className="note-list">
        {bookmarkedNotes.map((ev) => {
          const replies = getRepliesTo(ev.id).sort((a, b) => a.created_at - b.created_at);
          return (
            <NoteThread
              key={ev.id}
              event={ev}
              state={state}
              actions={{ ...actions, onBookmark: undefined }}
              replies={replies}
              showReplyActions={false}
            />
          );
        })}
      </ul>
      {bookmarkIds.size === 0 && <p className="muted">No bookmarks yet. Use Bookmark on any note to save it here.</p>}
    </section>
  );
}
