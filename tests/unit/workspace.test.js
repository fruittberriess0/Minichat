import { describe, expect, it } from "vitest";
import { createWorkspaceStore, filterChats } from "../../src/state/workspace.js";

function memoryStorage() {
  const data = new Map();
  return {getItem:key => data.get(key),setItem:(key,value) => data.set(key,value)};
}

describe("account-scoped workspace preferences", () => {
  it("keeps drafts and favorites separate across accounts and chats", () => {
    const storage = memoryStorage();
    const alice = createWorkspaceStore("alice",storage);
    const bob = createWorkspaceStore("bob",storage);
    alice.saveDraft("chat-a","личный черновик");
    alice.saveDraft("chat-b","другой текст");
    alice.toggleFavorite("chat-a");
    expect(bob.draft("chat-a")).toBe("");
    expect(bob.favorites()).toEqual([]);
    expect(alice.draft("chat-b")).toBe("другой текст");
    expect(createWorkspaceStore("alice",storage).draft("chat-a")).toBe("личный черновик");
    alice.saveDraft("chat-a","");
    expect(alice.draft("chat-a")).toBe("");
    alice.toggleFavorite("chat-a");
    expect(alice.favorites()).toEqual([]);
  });

  it("recovers from malformed storage and reports write failures", () => {
    for (const corrupt of ["null","[]","true","broken",'{"drafts":null,"favorites":42}']) {
      const store = createWorkspaceStore("alice",{getItem:() => corrupt,setItem:() => {throw new Error("quota");}});
      expect(store.draft("chat")).toBe("");
      expect(store.favorites()).toEqual([]);
      expect(store.saveDraft("chat","text")).toBe(false);
      expect(store.toggleFavorite("chat")).toBe(false);
    }
  });
});

describe("chat list filters", () => {
  const chats = [{id:"a",title:"Друзья"},{id:"b",title:"Семья"},{id:"c",is_group:true}];
  const summaries = {a:{unread:2},b:{unread:0}};
  it("combines search, unread and favorite filters without mutating source order", () => {
    expect(filterChats(chats,summaries,["b"],"all").map(chat => chat.id)).toEqual(["b","a","c"]);
    expect(filterChats(chats,summaries,["b"],"unread").map(chat => chat.id)).toEqual(["a"]);
    expect(filterChats(chats,summaries,["b"],"favorites"," СЕМ ").map(chat => chat.id)).toEqual(["b"]);
    expect(filterChats(chats,summaries,[],"all","Групповой").map(chat => chat.id)).toEqual(["c"]);
    expect(chats.map(chat => chat.id)).toEqual(["a","b","c"]);
  });
});
