import SwiftUI

/// The full player, as the desktop's (src/ui/PlayerPane.tsx), laid out
/// across the TV: where you are as a sentence at the top; the book, the
/// chapter's progress and the transport on the left; what you can change
/// about listening, and the book's chapters, on the right. The focus starts
/// on play; Menu goes back where you came from, and the narration plays on.
/// An iPad held upright has the settings under the book, scrolling with it.
struct PlayerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.upright) private var upright
    @State private var chapters = false
    @State private var bookmarks = false
    @FocusState private var playFocused: Bool

    var body: some View {
        ZStack {
            Color.canvas.ignoresSafeArea()
            if let listening = model.listening {
                let settings = VStack(alignment: .leading, spacing: 40.scaled) {
                    ListeningGroup(listening: listening)
                    ThisBookGroup(listening: listening, chapters: $chapters, bookmarks: $bookmarks)
                }
                Group {
                    if upright {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 48.scaled) {
                                Header(listening: listening)
                                NowPlaying(listening: listening, playFocused: $playFocused)
                                settings
                            }
                            .screenEdges(horizontal: 96, vertical: 56)
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 48.scaled) {
                            Header(listening: listening)
                            HStack(alignment: .top, spacing: 96.scaled) {
                                NowPlaying(listening: listening, playFocused: $playFocused)
                                    .frame(width: 660.scaled)
                                ScrollView {
                                    settings.padding(24.scaled)
                                }
                                .padding(-24.scaled)
                                .scrollClipDisabled()
                            }
                        }
                        .screenEdges(horizontal: 96, vertical: 56)
                    }
                }
                .defaultFocus($playFocused, true)
                // Come to from the end of the book before, the focus would stay where that card's button was.
                .onAppear { playFocused = true }
                .sheet(isPresented: $chapters) { ChapterSheet(listening: listening) { chapters = false } }
                .sheet(isPresented: $bookmarks) { BookmarkSheet(listening: listening) { bookmarks = false } }
                // Bookmarks made on other devices since.
                .task(id: listening.book.id) { await listening.bookmarks.load() }
            } else {
                Text("Choose a book from your library to start listening.").font(.ui(28)).foregroundStyle(Color.ink2)
            }
        }
    }
}

/// The way back, and where you are, in one sentence beside a rule. The iPad's way back is a button above it.
private struct Header: View {
    let listening: Listening

    var body: some View {
        VStack(alignment: .leading, spacing: 14.scaled) {
            #if os(tvOS)
            HStack(spacing: 10) {
                Text("Library").foregroundStyle(Color.ink3)
                Text("›").foregroundStyle(Color.ink3)
                Text(listening.book.title).foregroundStyle(Color.ink2)
            }
            .font(.ui(22))
            .lineLimit(1)
            #endif
            Text(sentence)
                .font(.ui(26)).foregroundStyle(Color.ink).monospacedDigit()
                .padding(.leading, 18.scaled)
                .overlay(alignment: .leading) { Rectangle().fill(Color.lineStrong).frame(width: 2) }
        }
    }

    /// "Chapter 4, 12% through, 9h 40m left at 1.25×." A chapter by its own name, never its place among the
    /// markers, which count the credits too.
    private var sentence: String {
        let percent = listening.durationMs > 0 ? listening.positionMs * 100 / listening.durationMs : 0
        let left = Format.left(Format.atSpeed(listening.durationMs - listening.positionMs, listening.speed))
        let where_ = listening.chapters.count > 1 ? listening.chapter.map { "\($0.title), " } ?? "" : ""
        return "\(where_)\(percent)% through, \(left) left\(listening.speed != 1 ? " at \(Format.speed(listening.speed))" : "")."
    }
}

/// The book in the middle: its cover, title and who wrote and reads it, the chapter's progress, and the transport.
private struct NowPlaying: View {
    let listening: Listening
    var playFocused: FocusState<Bool>.Binding
    @Environment(\.narrow) private var narrow

    var body: some View {
        let book = listening.book
        // The timeline is the chapter: books run ten hours and more, and a whole-book line barely moves.
        let chapter = listening.chapter
        let start = chapter?.startMs ?? 0
        let length = chapter.map { $0.endMs - $0.startMs } ?? listening.durationMs
        let inChapter = min(length, max(0, listening.positionMs - start))
        VStack(spacing: 0) {
            // On a phone, the cover above the title.
            let top = narrow ? AnyLayout(VStackLayout(alignment: .leading, spacing: 24.scaled)) : AnyLayout(HStackLayout(alignment: .center, spacing: 36.scaled))
            top {
                CoverView(book: book, size: 300)
                VStack(alignment: .leading, spacing: 10.scaled) {
                    Text(book.title).font(.ui(36, weight: 600)).foregroundStyle(Color.ink).lineLimit(3)
                    Text("\(book.author.isEmpty ? "Unknown author" : book.author)\(book.narrator.isEmpty ? "" : ", read by \(book.narrator)")").font(.ui(24)).foregroundStyle(Color.ink2).lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .leading, spacing: 12.scaled) {
                if let chapter {
                    HStack(alignment: .firstTextBaseline) {
                        Text(chapter.title).font(.ui(26, weight: 500)).foregroundStyle(Color.ink).lineLimit(1)
                        Spacer()
                        Text("-\(Format.duration(Format.atSpeed(length - inChapter, listening.speed)))").font(.ui(22)).foregroundStyle(Color.ink3).monospacedDigit()
                    }
                }
                ProgressLine(fraction: length > 0 ? Double(inChapter) / Double(length) : 0).frame(height: 6.scaled)
                HStack {
                    Text(Format.duration(inChapter))
                    Spacer()
                    Text(Format.duration(length))
                }
                .font(.ui(20)).foregroundStyle(Color.ink3).monospacedDigit()
            }
            .padding(.top, 56.scaled)
            HStack(spacing: narrow ? 12 : 36.scaled) {
                Button { listening.chapter(by: -1) } label: { Image(systemName: "backward.end.fill") }
                    .buttonStyle(RoundButtonStyle(size: 72))
                Button { listening.skip(by: -30_000) } label: { Image(systemName: "gobackward.30") }
                    .buttonStyle(RoundButtonStyle(size: 80))
                Button { listening.playPause() } label: { Image(systemName: listening.playing ? "pause.fill" : "play.fill") }
                    .buttonStyle(RoundButtonStyle(size: 112, primary: true))
                    .focused(playFocused)
                Button { listening.skip(by: 30_000) } label: { Image(systemName: "goforward.30") }
                    .buttonStyle(RoundButtonStyle(size: 80))
                Button { listening.chapter(by: 1) } label: { Image(systemName: "forward.end.fill") }
                    .buttonStyle(RoundButtonStyle(size: 72))
            }
            .padding(.top, 40.scaled)
            if let ms = listening.dozedOffer {
                Offer(words: "You dozed off around \(Format.duration(ms))\(chapterOf(ms).map { ", in \(listening.chapters[$0].title)" } ?? "").", take: "Go back to where you dozed off", action: listening.goBackToDozed, dismiss: listening.dozing.forget)
                    .padding(.top, 28.scaled)
            } else if let offer = listening.resumeOffer {
                Offer(words: "You were away for \(Format.away(offer.awayMs)). Start this chapter over?", take: "Start it over", action: listening.restartChapter, dismiss: listening.dismissResumeOffer)
                    .padding(.top, 28.scaled)
            } else {
                Text(listening.playing ? " " : "Paused").font(.ui(22)).foregroundStyle(Color.ink3).padding(.top, 20.scaled)
            }
        }
    }

    private func chapterOf(_ ms: Int) -> Int? {
        listening.chapters.count > 1 ? listening.chapters.lastIndex { $0.startMs <= ms } : nil
    }
}

/// Something offered on resuming, once, quietly, as the desktop's (src/ui/ResumeOffer.tsx): a line, the way to take
/// it, and Keep going, which lets it go. Down from the transport reaches it. On a phone, one above the other.
private struct Offer: View {
    let words: String
    let take: String
    let action: () -> Void
    let dismiss: () -> Void
    @Environment(\.narrow) private var narrow

    var body: some View {
        VStack(spacing: 16.scaled) {
            Text(words).font(.ui(22)).foregroundStyle(Color.ink2).multilineTextAlignment(.center).monospacedDigit()
            let choices = narrow ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 14.scaled))
            choices {
                Button(take, action: action).buttonStyle(SmallButtonStyle())
                Button("Keep going", action: dismiss).buttonStyle(SmallButtonStyle())
            }
        }
        .padding(.horizontal, 24.scaled)
        .padding(.vertical, 18.scaled)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 14.scaled).fill(Color.surface))
        .overlay(RoundedRectangle(cornerRadius: 14.scaled).stroke(Color.line))
    }
}

/// Speed and the sleep timer, as the desktop's Listening group.
private struct ListeningGroup: View {
    let listening: Listening

    var body: some View {
        Rows(label: "Listening") {
            Row(title: "Speed", description: listening.speed != 1 ? "Kept for this book. \(Format.left(Format.atSpeed(listening.durationMs - listening.positionMs, listening.speed))) left at this speed." : "Kept for this book.") {
                HStack(spacing: 18.scaled) {
                    Button { listening.setSpeed(listening.speed - Listening.speedStep) } label: { Image(systemName: "minus") }
                        .buttonStyle(RoundButtonStyle(size: 52))
                    Text(Format.speed(listening.speed)).font(.ui(26, weight: 500)).foregroundStyle(Color.ink).frame(width: 90.scaled)
                    Button { listening.setSpeed(listening.speed + Listening.speedStep) } label: { Image(systemName: "plus") }
                        .buttonStyle(RoundButtonStyle(size: 52))
                }
            }
            SleepRow(listening: listening)
        }
    }
}

/// The sleep timer as one row: the choices, or what is left with a way to add time or stop (src/ui/SleepControl.tsx).
/// On a phone the choices take two rows.
private struct SleepRow: View {
    let listening: Listening
    @Environment(\.narrow) private var narrow

    var body: some View {
        VStack(alignment: .leading, spacing: 18.scaled) {
            HStack(alignment: .firstTextBaseline, spacing: 14.scaled) {
                Image(systemName: "moon.fill").font(.system(size: 22.scaled)).foregroundStyle(listening.sleep == nil ? Color.ink3 : Color.ink)
                VStack(alignment: .leading, spacing: 4.scaled) {
                    Text("Sleep timer").font(.ui(26, weight: 500)).foregroundStyle(Color.ink)
                    // Counting down by the second while it's on.
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        Text(status).font(.ui(22)).foregroundStyle(Color.ink2).monospacedDigit()
                    }
                }
            }
            HStack(spacing: 12.scaled) {
                if listening.sleep == nil && narrow {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) { minutes([15, 30, 45]) }
                        HStack(spacing: 8) {
                            minutes([60])
                            endOfChapter
                        }
                    }
                } else if listening.sleep == nil {
                    minutes([15, 30, 45, 60])
                    endOfChapter
                } else {
                    if case .at = listening.sleep {
                        Button("+15 min") { listening.extendSleep(by: 15) }.buttonStyle(SmallButtonStyle())
                    }
                    Button("Turn off") { listening.sleep(after: nil) }.buttonStyle(SmallButtonStyle())
                }
            }
            .padding(.leading, narrow ? 0 : 36.scaled)
        }
        .padding(.horizontal, 22.scaled)
        .padding(.vertical, 18.scaled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10.scaled).fill(Color.raised))
    }

    private func minutes(_ choices: [Int]) -> some View {
        ForEach(choices, id: \.self) { minutes in
            Button("\(minutes) min") { listening.sleep(after: minutes) }.buttonStyle(SmallButtonStyle())
        }
    }

    private var endOfChapter: some View {
        Button("End of chapter") { listening.sleepAtChapterEnd() }.buttonStyle(SmallButtonStyle())
    }

    private var status: String {
        switch listening.sleep {
        case nil: "Fades out, and stops at a chapter's end if you like."
        case .endOfChapter: "At the end of this chapter"
        case .at(let date): "\(Format.duration(Int(max(0, date.timeIntervalSinceNow) * 1000))) left"
        }
    }
}

/// The book's chapters, reading along, and what it says about itself.
private struct ThisBookGroup: View {
    @Environment(AppModel.self) private var model
    let listening: Listening
    @Binding var chapters: Bool
    @Binding var bookmarks: Bool
    @State private var moreAbout = false

    var body: some View {
        let count = listening.chapters.count
        Rows(label: "This book") {
            Button { chapters = true } label: {
                Row(title: "Chapters") { Text(count > 1 ? listening.chapter?.title ?? "" : String(count)) }
            }
            .buttonStyle(LiftStyle.row())
            Button { bookmarks = true } label: {
                Row(title: "Bookmarks", description: listening.bookmarks.all.isEmpty ? Self.howToBookmark : nil) { Text(String(listening.bookmarks.all.count)) }
            }
            .buttonStyle(LiftStyle.row())
            if listening.book.ebook {
                Button { Task { await model.readAlong(listening.book) } } label: {
                    Row(title: model.opening == listening.book.id ? "Opening…" : "Read along", description: "The text, with the sentence being read marked.") { Image(systemName: "book") }
                }
                .buttonStyle(LiftStyle.row())
            }
            if let about = listening.detail.book.description, !about.isEmpty {
                Button { withAnimation(.easeOut(duration: 0.2)) { moreAbout.toggle() } } label: {
                    VStack(alignment: .leading, spacing: 8.scaled) {
                        Text("About").font(.ui(26, weight: 500)).foregroundStyle(Color.ink)
                        Text(about).font(.ui(22)).foregroundStyle(Color.ink2).lineSpacing(6.scaled).lineLimit(moreAbout ? nil : 4).multilineTextAlignment(.leading)
                        Text(moreAbout ? "Less" : "More").font(.ui(20, weight: 500)).foregroundStyle(Color.ink3)
                    }
                    .padding(.horizontal, 22.scaled)
                    .padding(.vertical, 18.scaled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10.scaled).fill(Color.raised))
                }
                .buttonStyle(LiftStyle.row())
            }
        }
    }

    #if os(tvOS)
    static let howToBookmark = "Hold Select on the words in Read along to keep them."
    #else
    static let howToBookmark = "Hold the words in Read along to keep them."
    #endif
}

/// Every chapter, the one playing marked in amber: choosing one plays from its start.
private struct ChapterSheet: View {
    let listening: Listening
    let onDone: () -> Void
    @FocusState private var focused: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 28.scaled) {
            SectionHeader(title: "Chapters", description: "\(listening.chapters.count) in \(listening.book.title).") {
                SheetDone(action: onDone)
            }
            ScrollView {
                VStack(spacing: 4.scaled) {
                    ForEach(Array(listening.chapters.enumerated()), id: \.offset) { index, chapter in
                        let now = index == listening.chapterIndex
                        Button {
                            listening.play(from: chapter.startMs)
                            onDone()
                        } label: {
                            HStack(spacing: 24.scaled) {
                                Text(String(index + 1)).font(.ui(22)).foregroundStyle(Color.ink3).monospacedDigit().frame(width: 56.scaled, alignment: .trailing)
                                Text(chapter.title).font(.ui(26, weight: now ? 500 : 400)).foregroundStyle(Color.ink).lineLimit(1)
                                Spacer(minLength: 24.scaled)
                                Text(Format.duration(chapter.endMs - chapter.startMs)).font(.ui(22)).foregroundStyle(Color.ink3).monospacedDigit()
                            }
                            .padding(.vertical, 16.scaled)
                            .padding(.leading, 16.scaled)
                            .padding(.trailing, 24.scaled)
                            .background(RoundedRectangle(cornerRadius: 12.scaled).fill(now ? Color.raised : Color.clear))
                            .overlay(alignment: .leading) {
                                if now { Capsule().fill(Color.place).frame(width: 4.scaled).padding(.vertical, 14.scaled) }
                            }
                        }
                        .buttonStyle(LiftStyle.row(radius: 12))
                        .focused($focused, equals: index)
                    }
                }
                .padding(24.scaled)
            }
            .padding(-24.scaled)
        }
        .screenEdges(horizontal: 64, vertical: 64)
        #if os(tvOS)
        .frame(width: 1100)
        #endif
        .background(Color.surface.ignoresSafeArea())
        .defaultFocus($focused, listening.chapterIndex)
    }
}

/// The book's bookmarks from every device, in the order of the book, as the desktop lists them
/// (src/ui/BookmarkList.tsx): the words, or the note, with the chapter and the time. Choosing one
/// listens from it; holding Select on one offers to delete it.
private struct BookmarkSheet: View {
    let listening: Listening
    let onDone: () -> Void

    var body: some View {
        let all = listening.bookmarks.all
        VStack(alignment: .leading, spacing: 28.scaled) {
            SectionHeader(title: "Bookmarks", description: all.isEmpty ? Self.none : "\(all.count) in \(listening.book.title), on every device.") {
                SheetDone(action: onDone)
            }
            ScrollView {
                VStack(spacing: 4.scaled) {
                    ForEach(all) { bookmark in
                        Button {
                            if let ms = bookmark.ms { listening.play(from: ms) }
                            onDone()
                        } label: {
                            HStack(alignment: .top, spacing: 20.scaled) {
                                Image(systemName: "bookmark.fill").font(.system(size: 20.scaled)).foregroundStyle(Color.place).padding(.top, 4.scaled)
                                VStack(alignment: .leading, spacing: 6.scaled) {
                                    Text(words(of: bookmark)).font(.ui(24)).foregroundStyle(Color.ink).lineLimit(3).multilineTextAlignment(.leading)
                                    Text(whereIs(bookmark)).font(.ui(20)).foregroundStyle(Color.ink3).monospacedDigit().lineLimit(1)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 16.scaled)
                            .padding(.horizontal, 20.scaled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(LiftStyle.row(radius: 12))
                        .contextMenu {
                            Button("Delete bookmark", role: .destructive) {
                                Task { try? await listening.bookmarks.remove(bookmark) }
                            }
                        }
                    }
                }
                .padding(24.scaled)
            }
            .padding(-24.scaled)
        }
        .screenEdges(horizontal: 64, vertical: 64)
        #if os(tvOS)
        .frame(width: 1100)
        #endif
        .background(Color.surface.ignoresSafeArea())
    }

    #if os(tvOS)
    private static let none = "None yet. In Read along, hold Select on a sentence to keep it."
    #else
    private static let none = "None yet. In Read along, hold a sentence to keep it."
    #endif

    /// The words it marks, or its note, or that it's a moment.
    private func words(of bookmark: ServerBookmark) -> String {
        if let quote = bookmark.quote { return "\u{201C}\(quote.replacingOccurrences(of: "\n\n", with: " "))\u{201D}" }
        if !bookmark.note.isEmpty { return bookmark.note }
        return "Bookmark at \(Format.duration(bookmark.ms ?? 0))"
    }

    /// "Chapter II The Council with the Munchkins · 11:03", as the desktop's list says it.
    private func whereIs(_ bookmark: ServerBookmark) -> String {
        guard let ms = bookmark.ms else { return "In the text" }
        let chapter = listening.chapters.last { $0.startMs <= ms }?.title
        return [chapter, Format.duration(ms)].compactMap { $0 }.joined(separator: " · ")
    }
}

/// A small raised button, as the sleep timer's choices are: lit in inverted ink with the focus.
struct SmallButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Lift(configuration: configuration)
    }

    private struct Lift: View {
        let configuration: Configuration
        @Environment(\.isFocused) private var focused

        var body: some View {
            configuration.label
                .font(.ui(22, weight: 500))
                .lineLimit(1)
                .fixedSize()
                .foregroundStyle(focused ? Color.canvas : Color.ink)
                .padding(.horizontal, 20.scaled)
                .padding(.vertical, 10.scaled)
                .background(RoundedRectangle(cornerRadius: 10.scaled).fill(focused ? Color.ink : Color.white.opacity(0.06)))
                .overlay(RoundedRectangle(cornerRadius: 10.scaled).stroke(focused ? Color.clear : Color.line))
                .scaleEffect(configuration.isPressed ? Pressed.button(settlingTo: 1.02) : focused ? 1.08 : 1)
                .lifts(focused: focused, pressed: configuration.isPressed)
        }
    }
}

/// Done, at the top of a sheet on the iPad, which has no Menu to close it with; on the TV, nothing.
private struct SheetDone: View {
    let action: () -> Void

    var body: some View {
        #if os(iOS)
        Button("Done", action: action).buttonStyle(RibbonButtonStyle())
        #endif
    }
}
