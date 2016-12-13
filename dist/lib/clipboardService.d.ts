// ag-grid-enterprise v7.0.2
import { ColDef, IClipboardService, Column } from "ag-grid/main";
export declare class ClipboardService implements IClipboardService {
    private csvCreator;
    private loggerFactory;
    private selectionController;
    private rangeController;
    private rowModel;
    private floatingRowModel;
    private valueService;
    private focusedCellController;
    private rowRenderer;
    private columnController;
    private eventService;
    private cellNavigationService;
    private gridOptionsWrapper;
    private gridCore;
    private logger;
    private init();
    pasteFromClipboard(): void;
    copyRangeDown(): void;
    private finishPasteFromClipboard(data);
    copyToClipboard(includeHeaders?: boolean): void;
    private iterateActiveRanges(onlyFirst, rowCallback, columnCallback?);
    private iterateActiveRange(range, rowCallback, columnCallback?);
    copySelectedRangeToClipboard(includeHeaders?: boolean): void;
    private processRangeCell(rowNode, column, value, func);
    private getRowNode(gridRow);
    copySelectedRowsToClipboard(includeHeaders?: boolean, columnKeys?: (string | Column | ColDef)[]): void;
    private htmlFormatter(dataObj?);
    private copyDataToClipboard(data, dataObj?);
    private executeOnTempElement(callbackNow, callbackAfter?);
    private dataToArray(strData);
}
