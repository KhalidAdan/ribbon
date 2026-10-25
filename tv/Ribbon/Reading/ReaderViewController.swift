import UIKit

/// The book as one long column, read with the Siri Remote: up and down step
/// a sentence, a swipe on the touch surface glides through several, and Play
/// or Select reads from the sentence the remote is on (ReadingSession). The
/// column moves only when the sentence leaves the middle of the screen, and
/// then glides, so the words stay still while they're read. Once the
/// narration has played a few seconds with the remote following it, every
/// other word steps back, dimmed, and the sentence being read is left at full
/// ink (the river); the remote moving away, or a pause, brings the whole page
/// back at once, so the words moved to can be read.
///
/// Left listens from the remote's sentence, and again a sentence further back
/// each time it's pressed again at once; right returns to the narrator.
/// Away from the narrator, the remote's sentence says so in the margins beside
/// its first line, which the text being justified leaves clear: Listen from
/// here on the left, Return to narrator on the right.
///
/// Holding Select starts a bookmark at the remote's sentence; up and down take
/// in more, and Select keeps it. Bookmarked words are underlined in amber, as
/// the desktop's reader underlines them, and holding Select on them offers to
/// delete the bookmark.
///
/// On the iPad the finger does what the remote does. It moves the column,
/// and the sentence at the eye line, a third of the way down, is the one
/// you're on, as a swipe on the remote glides through them; tapping a
/// sentence goes to it, and tapping it again listens from it. Holding a
/// sentence starts a bookmark, and tapping or scrolling takes in more.
/// Listen from here, Return to narrator, and play and pause are buttons under
/// the column (ReaderView). A keyboard's arrows are the remote's edges, and
/// space is its Play.
///
/// Only the paragraphs near the screen are drawn; the rest are measured
/// (BookLayout) and wait.
final class ReaderViewController: UIViewController, UIScrollViewDelegate {
    private let session: ReadingSession
    private let layout: BookLayout
    private let onClose: () -> Void

    private let column = UIScrollView()
    private var shown: [Int: ParagraphView] = [:]
    private var spare: [ParagraphView] = []
    /// The paragraphs with a wash on them now, to clear when the marks move.
    private var marked: Set<Int> = []
    private var lastCursor: Int?
    /// While the column glides, what it glides over stays drawn.
    private var gliding = false

    /// What left and right do, beside the remote's sentence.
    private let listenHere = SideLabel(title: "Listen from here", arrow: "chevron.left", leading: true)
    private let toNarrator = SideLabel(title: "Return to narrator", arrow: "chevron.right", leading: false)
    /// The bookmarks drawn, to draw again when they change.
    private var drawnBookmarks: [String] = []
    /// Whether the words not being read are drawn dimmed: the river (ReadingSession).
    private var dimmed = false

    /// Holding up or down keeps stepping, after a moment.
    private var repeater: Timer?
    /// Holding Select bookmarks, after this long; let go sooner, it plays and pauses.
    private var selectHeld: Timer?
    private var heldLong = false
    private static let holdFor: TimeInterval = 0.5
    /// How far a swipe on the touch surface has gone, in sentences already stepped.
    private var swiped: CGFloat = 0
    private static let swipePerSentence: CGFloat = 70
    /// Where the eyes are on the screen, from its top: a sentence brought into view sits here.
    private static let eyeLine: CGFloat = 0.32
    /// A finger is moving the column, or it's still gliding from one: the sentence at the eye line follows it, and
    /// the column is left where the finger puts it.
    private var fingerScrolling = false

    init(session: ReadingSession, layout: BookLayout, onClose: @escaping () -> Void) {
        self.session = session
        self.layout = layout
        self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("made in code") }

    override func loadView() {
        view = RemoteView()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Look.canvas
        column.delegate = self
        column.isScrollEnabled = false
        column.clipsToBounds = false
        column.contentInsetAdjustmentBehavior = .never
        view.addSubview(column)

        // The words fade in and out at the top and bottom, under the title and the time left.
        let fade = CAGradientLayer()
        fade.colors = [UIColor.clear, .black, .black, .clear].map(\.cgColor)
        fade.locations = [0.1, 0.2, 0.8, 0.9]
        view.layer.mask = fade

        #if os(tvOS)
        // In the column, so they move with the words.
        for button in [listenHere, toNarrator] {
            button.alpha = 0
            column.addSubview(button)
        }

        let swipe = UIPanGestureRecognizer(target: self, action: #selector(swiping))
        swipe.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirect.rawValue)]
        view.addGestureRecognizer(swipe)
        #else
        column.isScrollEnabled = true
        column.showsVerticalScrollIndicator = false
        // A finger anywhere on the screen moves the column, the margins too.
        view.addGestureRecognizer(column.panGestureRecognizer)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        view.addGestureRecognizer(tap)
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(held))
        hold.minimumPressDuration = Self.holdFor
        view.addGestureRecognizer(hold)
        #endif

        session.onMarks = { [weak self] in self?.marksChanged() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.layer.mask?.frame = view.bounds
        #if os(iOS)
        // Clear under the title, and under the buttons and the time left, which take more of the iPad's screen.
        let fadeTop = view.safeAreaInsets.top + 56
        let fadeBottom = view.bounds.height - view.safeAreaInsets.bottom - 150
        (view.layer.mask as? CAGradientLayer)?.locations = [fadeTop, fadeTop + 40, fadeBottom - 48, fadeBottom].map { NSNumber(value: Double($0 / max(1, view.bounds.height))) }
        #endif
        let height = view.bounds.height
        column.frame = CGRect(x: (view.bounds.width - BookLayout.Measure.width) / 2, y: 0, width: BookLayout.Measure.width, height: height)
        column.contentSize = CGSize(width: BookLayout.Measure.width, height: layout.height)
        // Room above the first sentence and below the last, so either can sit where the eyes are.
        column.contentInset = UIEdgeInsets(top: height * 0.5, left: 0, bottom: height * 0.6, right: 0)
        if lastCursor == nil { marksChanged() }
    }

    override var preferredFocusEnvironments: [UIFocusEnvironment] { [view] }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        setNeedsFocusUpdate()
        updateFocusIfNeeded()
        #if os(iOS)
        // A keyboard's keys come to the reader, as the remote's presses do on the TV.
        becomeFirstResponder()
        #endif
    }

    #if os(iOS)
    override var canBecomeFirstResponder: Bool { true }

    /// Turned, the iPad keeps the sentence you're on where the eyes are.
    override func viewWillTransition(to size: CGSize, with coordinator: any UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: nil) { _ in
            self.bringIntoView(self.session.cursor, gently: false)
        }
    }
    #endif

    // The remote ---------------------------------------------------------

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard let press = presses.first else { return super.pressesBegan(presses, with: event) }
        #if DEBUG
        // The simulator's remote can't be held, and a keyboard has no Menu: in a debug build, Page Down holds Select
        // and Delete is Menu (tv/README.md).
        #if os(tvOS)
        if press.type == .pageDown { return session.holdSelect() }
        #endif
        if press.key?.keyCode == .keyboardDeleteOrBackspace { return session.back() ? () : onClose() }
        #endif
        switch Self.button(of: press) {
        case .upArrow: hold { $0.session.step(by: -1) }
        case .downArrow: hold { $0.session.step(by: 1) }
        case .leftArrow:
            if !bookmarking { session.left() }
        case .rightArrow:
            if !bookmarking { session.returnToNarrator() }
        case .select:
            // What Select does is known when it's let go, or once it's been held long enough.
            heldLong = false
            selectHeld?.invalidate()
            selectHeld = Timer.scheduledTimer(withTimeInterval: Self.holdFor, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.heldLong = true
                    self.session.holdSelect()
                }
            }
        case .playPause:
            if !bookmarking { session.playPause() }
        case .menu:
            if !session.back() { onClose() }
        default: super.pressesBegan(presses, with: event)
        }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        repeater?.invalidate()
        repeater = nil
        if presses.contains(where: { Self.button(of: $0) == .select }) {
            selectHeld?.invalidate()
            selectHeld = nil
            if !heldLong { pressSelect() }
            heldLong = false
        }
        super.pressesEnded(presses, with: event)
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        repeater?.invalidate()
        repeater = nil
        selectHeld?.invalidate()
        selectHeld = nil
        heldLong = false
        super.pressesCancelled(presses, with: event)
    }

    /// Select pressed and let go: keep the bookmark being made, delete the one offered, or play and pause.
    private func pressSelect() {
        if session.marking != nil {
            session.keepBookmark()
        } else if session.deleting != nil {
            session.deleteBookmark()
        } else {
            session.playPause()
        }
    }

    /// A bookmark is being made, or one is offered for deleting: left, right and Play wait.
    private var bookmarking: Bool {
        session.marking != nil || session.deleting != nil
    }

    /// Which of the remote's buttons a press is. On the iPad a keyboard stands in for the remote: the arrows are
    /// its edges and space is Play. (Return and escape never come here: iPadOS keeps them.)
    private static func button(of press: UIPress) -> UIPress.PressType {
        #if os(iOS)
        switch press.key?.keyCode {
        case .keyboardUpArrow: return .upArrow
        case .keyboardDownArrow: return .downArrow
        case .keyboardLeftArrow: return .leftArrow
        case .keyboardRightArrow: return .rightArrow
        case .keyboardSpacebar: return .playPause
        default: break
        }
        #endif
        return press.type
    }

    /// Step once now, then again and again while the button is held.
    private func hold(_ step: @escaping (ReaderViewController) -> Void) {
        step(self)
        repeater?.invalidate()
        repeater = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.repeater = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        step(self)
                    }
                }
            }
        }
    }

    @objc private func swiping(_ pan: UIPanGestureRecognizer) {
        if pan.state == .began { swiped = 0 }
        guard pan.state == .changed else { return }
        let steps = (pan.translation(in: view).y / Self.swipePerSentence).rounded(.towardZero)
        if steps != swiped {
            session.step(by: Int(steps - swiped))
            swiped = steps
        }
    }

    // The finger, on the iPad -----------------------------------------------

    #if os(iOS)
    /// A tap on a sentence goes to it, as up and down do; on the sentence you're on, away from the narrator, it
    /// listens from there, as Select does. While a bookmark is made, it takes in the words up to the one tapped.
    @objc private func tapped(_ tap: UITapGestureRecognizer) {
        guard let sentence = sentence(at: tap.location(in: column)) else { return }
        if sentence == session.cursor && !session.following && session.marking == nil {
            session.listenFromHere()
        } else {
            session.show(sentence)
        }
    }

    /// Holding a sentence is holding Select on it: a bookmark starts there, or, on one, it's offered for deleting.
    @objc private func held(_ hold: UILongPressGestureRecognizer) {
        guard hold.state == .began, let sentence = sentence(at: hold.location(in: column)) else { return }
        if !bookmarking { session.show(sentence) }
        session.holdSelect()
    }

    /// The sentence under a point on the column.
    private func sentence(at point: CGPoint) -> Int? {
        guard let block = layout.paragraph(at: point.y) else { return nil }
        let paragraph = layout.paragraphs[block]
        let inside = CGPoint(x: min(max(0, point.x), BookLayout.Measure.width), y: point.y - paragraph.top)
        return session.sentences.at(paragraph.character(at: inside), in: block)
    }

    /// The column moved by the finger: the sentence at the eye line is the one you're on. It's the one whose words
    /// end that line, as a sentence brought into view sits with its first line there.
    private func followTheFinger() {
        let eye = column.contentOffset.y + column.bounds.height * Self.eyeLine + BookLayout.Measure.lineHeight / 2
        guard let sentence = sentence(at: CGPoint(x: BookLayout.Measure.width, y: eye)), sentence != session.cursor else { return }
        session.show(sentence)
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        // A finger on the column stops its glide where it is.
        if gliding, let shown = column.layer.presentation()?.bounds.origin.y {
            column.layer.removeAllAnimations()
            column.contentOffset.y = shown
            gliding = false
        }
        fingerScrolling = true
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { fingerScrolling = false }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        fingerScrolling = false
    }
    #endif

    // The column ---------------------------------------------------------

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if !gliding { tile(around: visible(at: column.contentOffset.y)) }
        #if os(iOS)
        if fingerScrolling { followTheFinger() }
        #endif
    }

    /// The stretch of the column on screen when it's scrolled to `offset`.
    private func visible(at offset: CGFloat) -> ClosedRange<CGFloat> {
        offset...(offset + column.bounds.height)
    }

    /// Have the paragraphs in a stretch of the column drawn, a screen beyond it either way, and only those.
    private func tile(around stretch: ClosedRange<CGFloat>) {
        let margin = column.bounds.height
        let wanted = layout.paragraphs(from: stretch.lowerBound - margin, to: stretch.upperBound + margin)
        for (index, view) in shown where !wanted.contains(index) {
            view.removeFromSuperview()
            spare.append(view)
            shown[index] = nil
        }
        for index in wanted where shown[index] == nil {
            let view = spare.popLast() ?? ParagraphView()
            let paragraph = layout.paragraphs[index]
            view.frame = CGRect(x: 0, y: paragraph.top, width: BookLayout.Measure.width, height: paragraph.height).insetBy(dx: -ParagraphView.bleed, dy: -ParagraphView.bleed)
            show(index, in: view)
            column.addSubview(view)
            shown[index] = view
        }
    }

    /// The marks moved: wash the narrator's sentence, the remote's and a bookmark being made, underline the bookmarks,
    /// and bring the remote's sentence into view when it moved.
    private func marksChanged() {
        var now = Set(washedSentences().map { session.sentences[$0.sentence].block })
        if let range = session.markingRange {
            now.formUnion(session.sentences[range.lowerBound].block...session.sentences[range.upperBound].block)
        }
        // Bookmarks made or deleted, here or on another device, are drawn again everywhere they show; so is every
        // paragraph when the river comes or goes, and the words not being read dim or come back.
        let bookmarks = session.bookmarks.all.map(\.id)
        let dim = session.river
        let again = bookmarks != drawnBookmarks || dim != dimmed ? Set(shown.keys) : []
        // The river comes in slowly, so it doesn't pull at the eye, and goes at once, so the words moved to can be read.
        let duration = dim == dimmed ? 0.2 : dim ? 0.6 : 0.1
        drawnBookmarks = bookmarks
        dimmed = dim
        for index in marked.union(now).union(again) {
            guard let view = shown[index] else { continue }
            UIView.transition(with: view, duration: duration, options: .transitionCrossDissolve) {
                self.show(index, in: view)
            }
        }
        marked = now
        if lastCursor != session.cursor {
            // Where a finger has put the column, it stays.
            if !fingerScrolling { bringIntoView(session.cursor, gently: lastCursor != nil) }
            lastCursor = session.cursor
        }
        showSideLabels()
    }

    /// What left and right do, beside the first line of the remote's sentence when it's away from the narrator;
    /// hidden when it isn't, and while a bookmark is made. The iPad has them as buttons under the column instead.
    private func showSideLabels() {
        #if os(tvOS)
        let away = !session.following && !bookmarking
        if away, let line = layout.firstLine(of: session.sentences[session.cursor]) {
            let gap: CGFloat = 40
            for button in [listenHere, toNarrator] { button.sizeToFit() }
            let place = {
                self.listenHere.center = CGPoint(x: -gap - self.listenHere.bounds.width / 2, y: line.midY)
                self.toNarrator.center = CGPoint(x: BookLayout.Measure.width + gap + self.toNarrator.bounds.width / 2, y: line.midY)
            }
            // They glide with the sentence once they're showing; they appear where it is.
            if listenHere.alpha > 0 { UIView.animate(withDuration: 0.2, animations: place) } else { place() }
        }
        UIView.animate(withDuration: 0.15) {
            for button in [self.listenHere, self.toNarrator] { button.alpha = away ? 1 : 0 }
        }
        #endif
    }

    /// The sentences washed now: the narrator's in amber when it's placed to the sentence, and the remote's lifted when it's elsewhere.
    private func washedSentences() -> [(sentence: Int, colour: UIColor)] {
        var out: [(Int, UIColor)] = []
        if session.narratorExact { out.append((session.narrator, Look.placeWash)) }
        if session.cursor != session.narrator || !session.narratorExact { out.append((session.cursor, Look.focusWash)) }
        return out
    }

    /// A paragraph drawn with its washes and underlines, and, while the narration plays, its words dimmed but for the
    /// ones that matter now.
    private func show(_ block: Int, in view: ParagraphView) {
        view.show(layout.paragraphs[block], washes: washes(in: block), underlines: underlines(in: block), lit: dimmed ? lit(in: block) : nil)
    }

    /// The words left at full ink while the rest dim: the sentence being read, the remote's, and a bookmark being made.
    private func lit(in block: Int) -> [NSRange] {
        var out: [NSRange] = []
        for index in Set([session.narrator, session.cursor]) where session.sentences[index].block == block {
            out.append(session.sentences[index].range)
        }
        if let range = session.markingRange, let span = session.sentences.span(of: range, in: block) { out.append(span) }
        return out
    }

    private func washes(in block: Int) -> [(NSRange, UIColor)] {
        // A bookmark being made is lifted as the remote's sentence is, all of it.
        if let range = session.markingRange {
            return session.sentences.span(of: range, in: block).map { [($0, Look.focusWash)] } ?? []
        }
        return washedSentences().compactMap { washed in
            let sentence = session.sentences[washed.sentence]
            return sentence.block == block ? (sentence.range, washed.colour) : nil
        }
    }

    /// The bookmarked words in a paragraph, in amber, and the one being made, fainter; the one offered for deleting, fainter still.
    private func underlines(in block: Int) -> [(NSRange, UIColor)] {
        var out: [(NSRange, UIColor)] = []
        for bookmark in session.bookmarks.all {
            guard let sentences = bookmark.sentences, let span = session.sentences.span(of: sentences, in: block) else { continue }
            out.append((span, bookmark.id == session.deleting?.id ? Look.place.withAlphaComponent(0.3) : Look.place))
        }
        if let range = session.markingRange, let span = session.sentences.span(of: range, in: block) {
            out.append((span, Look.place.withAlphaComponent(0.6)))
        }
        return out
    }

    /// Scroll so a sentence sits a third of the way down the screen, when it's out of the middle of it:
    /// gliding when it's near, at once when it's far.
    private func bringIntoView(_ index: Int, gently: Bool) {
        let height = column.bounds.height
        guard height > 0 else { return }
        let frame = layout.frame(of: session.sentences[index])
        let offset = column.contentOffset.y
        let inMiddle = frame.minY >= offset + height * 0.2 && frame.maxY <= offset + height * 0.66
        guard !inMiddle || !gently else { return }
        let target = min(max(frame.minY - height * Self.eyeLine, -column.contentInset.top), layout.height + column.contentInset.bottom - height)
        if gently && abs(target - offset) < height * 1.5 {
            // Everything the glide passes over is drawn before it starts.
            tile(around: min(offset, target)...(max(offset, target) + height))
            gliding = true
            UIView.animate(withDuration: 0.6, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState, .allowUserInteraction]) {
                self.column.contentOffset.y = target
            } completion: { _ in
                self.gliding = false
                self.tile(around: self.visible(at: self.column.contentOffset.y))
            }
        } else {
            column.contentOffset.y = target
            tile(around: visible(at: target))
        }
    }
}

/// What left or right does, beside the remote's sentence: the app's
/// secondary button (docs/DESIGN.md, section 7) at the TV's size, with the
/// arrow it answers to. The reader keeps the focus itself, so up and down
/// still move through the text.
private final class SideLabel: UIView {
    private let label = UILabel()
    private let arrow = UIImageView()
    private let leading: Bool
    private let padding = UIEdgeInsets(top: 12, left: 20, bottom: 12, right: 24)
    private let gap: CGFloat = 12

    init(title: String, arrow symbol: String, leading: Bool) {
        self.leading = leading
        super.init(frame: .zero)
        label.text = title
        label.font = Faces.ui(size: 24, weight: 500)
        label.textColor = Look.ink2
        arrow.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold))
        arrow.tintColor = Look.ink3
        arrow.contentMode = .center
        addSubview(label)
        addSubview(arrow)
        backgroundColor = Look.raised
        layer.cornerRadius = 12
        layer.borderWidth = 1
        layer.borderColor = UIColor(white: 1, alpha: 0.08).cgColor
    }

    required init?(coder: NSCoder) { fatalError("made in code") }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let text = label.intrinsicContentSize
        let glyph = arrow.intrinsicContentSize
        return CGSize(width: glyph.width + gap + text.width + padding.left + padding.right, height: max(text.height, glyph.height) + padding.top + padding.bottom)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let inside = bounds.inset(by: padding)
        let glyph = arrow.intrinsicContentSize.width
        // The arrow on the side it points to.
        if leading {
            arrow.frame = CGRect(x: inside.minX, y: inside.minY, width: glyph, height: inside.height)
            label.frame = CGRect(x: inside.minX + glyph + gap, y: inside.minY, width: inside.width - glyph - gap, height: inside.height)
        } else {
            label.frame = CGRect(x: inside.minX, y: inside.minY, width: inside.width - glyph - gap, height: inside.height)
            arrow.frame = CGRect(x: inside.maxX - glyph, y: inside.minY, width: glyph, height: inside.height)
        }
    }
}

/// The reader's root view, which takes focus so the remote's presses come here.
private final class RemoteView: UIView {
    override var canBecomeFocused: Bool { true }
}

/// One paragraph on the column: its washes, then its words over them, dimmed but for some while the narration plays,
/// then the lines under bookmarked words.
private final class ParagraphView: UIView {
    /// Room around the paragraph for its washes, which reach a little past its words.
    static let bleed: CGFloat = 16.scaled

    private var paragraph: BookLayout.Paragraph?
    private var washes: [(NSRange, UIColor)] = []
    private var underlines: [(NSRange, UIColor)] = []
    /// While the words are dimmed, the ones drawn at full ink; nil when none are dimmed.
    private var lit: [NSRange]?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
    }

    required init?(coder: NSCoder) { fatalError("made in code") }

    func show(_ paragraph: BookLayout.Paragraph, washes: [(NSRange, UIColor)], underlines: [(NSRange, UIColor)], lit: [NSRange]?) {
        self.paragraph = paragraph
        self.washes = washes
        self.underlines = underlines
        self.lit = lit
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let paragraph, let context = UIGraphicsGetCurrentContext() else { return }
        context.translateBy(x: Self.bleed, y: Self.bleed)
        for (range, colour) in washes {
            colour.setFill()
            for box in paragraph.lineBoxes(range) {
                UIBezierPath(roundedRect: box.insetBy(dx: -8.scaled, dy: -2.scaled), cornerRadius: 6.scaled).fill()
            }
        }
        if let lit {
            // Every word faint, then the ones that matter again at full ink, over themselves.
            context.setAlpha(Look.dimmedWords)
            paragraph.draw()
            context.setAlpha(1)
            for range in lit { paragraph.draw(range) }
        } else {
            paragraph.draw()
        }
        for (range, colour) in underlines {
            colour.setFill()
            for box in paragraph.lineBoxes(range) {
                UIBezierPath(roundedRect: CGRect(x: box.minX, y: box.maxY + 2.scaled, width: box.width, height: 3.scaled), cornerRadius: 1.5.scaled).fill()
            }
        }
    }
}
