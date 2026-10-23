import UIKit

/// The book as one long column, read with the Siri Remote: up and down step
/// a sentence, left and right a paragraph, a swipe on the touch surface
/// glides through several, and Play or Select reads from the sentence the
/// remote is on (ReadingSession). The column moves only when the sentence
/// leaves the middle of the screen, and then glides, so the words stay still
/// while they're read.
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
        case .leftArrow: session.stepParagraph(by: -1)
        case .rightArrow: session.stepParagraph(by: 1)
        case .select, .playPause: session.playPause()
        case .menu: if !session.back() { onClose() }
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
