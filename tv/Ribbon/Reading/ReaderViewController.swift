import UIKit

/// The book as one long column, read with the Siri Remote: up and down step
/// a sentence, a swipe on the touch surface glides through several, and Play
/// or Select reads from the sentence the remote is on (ReadingSession). The
/// column moves only when the sentence leaves the middle of the screen, and
/// then glides, so the words stay still while they're read.
///
/// Away from the narrator, the sentence the remote is on has two buttons in
/// the margins beside its first line, which the text being justified leaves
/// clear: Listen from here on the left, Return to narrator on the right.
/// Left and right go to them, and back to the text; Select presses the one
/// that's lit. Following the narrator, left and right step a paragraph.
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

    /// The buttons beside the remote's sentence, and which of them the remote is on, if either.
    private let listenHere = SideButton(title: "Listen from here")
    private let toNarrator = SideButton(title: "Return to narrator")
    private var side: Side? {
        didSet { showSideButtons() }
    }

    private enum Side {
        case listen, narrator
    }

    /// Holding up or down keeps stepping, after a moment.
    private var repeater: Timer?
    /// How far a swipe on the touch surface has gone, in sentences already stepped.
    private var swiped: CGFloat = 0
    private static let swipePerSentence: CGFloat = 70

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
        // In the column, so they move with the words.
        for button in [listenHere, toNarrator] {
            button.alpha = 0
            column.addSubview(button)
        }

        // The words fade in and out at the top and bottom, under the title and the time left.
        let fade = CAGradientLayer()
        fade.colors = [UIColor.clear, .black, .black, .clear].map(\.cgColor)
        fade.locations = [0.1, 0.2, 0.8, 0.9]
        view.layer.mask = fade

        let swipe = UIPanGestureRecognizer(target: self, action: #selector(swiping))
        swipe.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirect.rawValue)]
        view.addGestureRecognizer(swipe)

        session.onMarks = { [weak self] in self?.marksChanged() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.layer.mask?.frame = view.bounds
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
    }

    // The remote ---------------------------------------------------------

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard let press = presses.first else { return super.pressesBegan(presses, with: event) }
        switch press.type {
        case .upArrow: hold { $0.session.step(by: -1) }
        case .downArrow: hold { $0.session.step(by: 1) }
        case .leftArrow:
            if session.following { session.stepParagraph(by: -1) } else { side = side == .narrator ? nil : .listen }
        case .rightArrow:
            if session.following { session.stepParagraph(by: 1) } else { side = side == .listen ? nil : .narrator }
        case .select, .playPause:
            switch side {
            case .listen: session.listenFromHere()
            case .narrator: session.returnToNarrator()
            case nil: session.playPause()
            }
        case .menu:
            if side != nil {
                side = nil
            } else if !session.back() {
                onClose()
            }
        default: super.pressesBegan(presses, with: event)
        }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        repeater?.invalidate()
        repeater = nil
        super.pressesEnded(presses, with: event)
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        repeater?.invalidate()
        repeater = nil
        super.pressesCancelled(presses, with: event)
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

    // The column ---------------------------------------------------------

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if !gliding { tile(around: visible(at: column.contentOffset.y)) }
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
            view.show(paragraph, washes: washes(in: index))
            column.addSubview(view)
            shown[index] = view
        }
    }

    /// The marks moved: wash the narrator's sentence and the remote's, and bring the remote's into view when it moved.
    private func marksChanged() {
        let now = Set(washedSentences().map { session.sentences[$0.sentence].block })
        for index in marked.union(now) {
            guard let view = shown[index] else { continue }
            UIView.transition(with: view, duration: 0.2, options: .transitionCrossDissolve) {
                view.show(self.layout.paragraphs[index], washes: self.washes(in: index))
            }
        }
        marked = now
        if lastCursor != session.cursor {
            bringIntoView(session.cursor, gently: lastCursor != nil)
            lastCursor = session.cursor
        }
        if session.following { side = nil } else { showSideButtons() }
    }

    /// The side buttons beside the first line of the remote's sentence when it's away from the narrator; hidden when it isn't.
    private func showSideButtons() {
        let away = !session.following
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
        listenHere.isLit = side == .listen
        toNarrator.isLit = side == .narrator
        UIView.animate(withDuration: 0.15) {
            for button in [self.listenHere, self.toNarrator] { button.alpha = away ? 1 : 0 }
        }
    }

    /// The sentences washed now: the narrator's in amber when it's placed to the sentence, and the remote's lifted when it's elsewhere.
    private func washedSentences() -> [(sentence: Int, colour: UIColor)] {
        var out: [(Int, UIColor)] = []
        if session.narratorExact { out.append((session.narrator, Look.placeWash)) }
        if session.cursor != session.narrator || !session.narratorExact { out.append((session.cursor, Look.focusWash)) }
        return out
    }

    private func washes(in block: Int) -> [(NSRange, UIColor)] {
        washedSentences().compactMap { washed in
            let sentence = session.sentences[washed.sentence]
            return sentence.block == block ? (sentence.range, washed.colour) : nil
        }
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
        let target = min(max(frame.minY - height * 0.32, -column.contentInset.top), layout.height + column.contentInset.bottom - height)
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

/// A button beside the remote's sentence, lit when the remote is on it: the
/// app's secondary button (docs/DESIGN.md, section 7) at the TV's size, and lit
/// as its primary, the way tvOS lifts what has the focus. The reader keeps
/// the focus itself and lights these, so up and down still move through the text.
private final class SideButton: UIView {
    private let label = UILabel()
    private let padding = UIEdgeInsets(top: 12, left: 24, bottom: 12, right: 24)

    var isLit = false {
        didSet {
            guard isLit != oldValue else { return }
            UIView.animate(withDuration: 0.15) { self.paint() }
        }
    }

    init(title: String) {
        super.init(frame: .zero)
        label.text = title
        label.font = Faces.ui(size: 24, weight: 500)
        addSubview(label)
        layer.cornerRadius = 12
        layer.borderWidth = 1
        paint()
    }

    required init?(coder: NSCoder) { fatalError("made in code") }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let text = label.intrinsicContentSize
        return CGSize(width: text.width + padding.left + padding.right, height: text.height + padding.top + padding.bottom)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.frame = bounds.inset(by: padding)
    }

    private func paint() {
        backgroundColor = isLit ? Look.ink : Look.raised
        label.textColor = isLit ? Look.canvas : Look.ink2
        layer.borderColor = (isLit ? Look.ink : UIColor(white: 1, alpha: 0.08)).cgColor
        transform = isLit ? CGAffineTransform(scaleX: 1.08, y: 1.08) : .identity
        layer.shadowOpacity = isLit ? 0.5 : 0
        layer.shadowRadius = 16
        layer.shadowOffset = CGSize(width: 0, height: 10)
    }
}

/// The reader's root view, which takes focus so the remote's presses come here.
private final class RemoteView: UIView {
    override var canBecomeFocused: Bool { true }
}

/// One paragraph on the column: its washes, then its words over them.
private final class ParagraphView: UIView {
    /// Room around the paragraph for its washes, which reach a little past its words.
    static let bleed: CGFloat = 16

    private var paragraph: BookLayout.Paragraph?
    private var washes: [(NSRange, UIColor)] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
    }

    required init?(coder: NSCoder) { fatalError("made in code") }

    func show(_ paragraph: BookLayout.Paragraph, washes: [(NSRange, UIColor)]) {
        self.paragraph = paragraph
        self.washes = washes
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let paragraph, let context = UIGraphicsGetCurrentContext() else { return }
        context.translateBy(x: Self.bleed, y: Self.bleed)
        for (range, colour) in washes {
            colour.setFill()
            for box in paragraph.lineBoxes(range) {
                UIBezierPath(roundedRect: box.insetBy(dx: -8, dy: -2), cornerRadius: 6).fill()
            }
        }
        paragraph.draw()
    }
}
