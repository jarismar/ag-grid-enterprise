import {
    Bean,
    RangeSelection,
    GridCellDef,
    CsvExportParams,
    ColDef,
    IClipboardService,
    Autowired,
    ProcessCellForExportParams,
    CsvCreator,
    LoggerFactory,
    SelectionController,
    IRowModel,
    PinnedRowModel,
    ValueService,
    FocusedCellController,
    RowRenderer,
    ColumnController,
    EventService,
    CellNavigationService,
    GridOptionsWrapper,
    Logger,
    PostConstruct,
    GridRow,
    Utils,
    GridCore,
    GridCell,
    Events,
    RowNode,
    Column,
    Constants,
    FlashCellsEvent,
    _,
    ColumnApi,
    GridApi
} from "ag-grid/main";
import {RangeController} from "./rangeController";

interface RowCallback {
    (gridRow: GridRow, rowNode: RowNode, columns: Column[], rangeIndex: number): void
}

interface ColumnCallback {
    (columns: Column[]): void
}

@Bean('clipboardService')
export class ClipboardService implements IClipboardService {

    @Autowired('csvCreator') private csvCreator: CsvCreator;
    @Autowired('loggerFactory') private loggerFactory: LoggerFactory;
    @Autowired('selectionController') private selectionController: SelectionController;
    @Autowired('rangeController') private rangeController: RangeController;
    @Autowired('rowModel') private rowModel: IRowModel;
    @Autowired('pinnedRowModel') private pinnedRowModel: PinnedRowModel;
    @Autowired('valueService') private valueService: ValueService;
    @Autowired('focusedCellController') private focusedCellController: FocusedCellController;
    @Autowired('rowRenderer') private rowRenderer: RowRenderer;
    @Autowired('columnController') private columnController: ColumnController;
    @Autowired('eventService') private eventService: EventService;
    @Autowired('cellNavigationService') private cellNavigationService: CellNavigationService;
    @Autowired('gridOptionsWrapper') private gridOptionsWrapper: GridOptionsWrapper;
    @Autowired('gridCore') private gridCore: GridCore;
    @Autowired('columnApi') private columnApi: ColumnApi;
    @Autowired('gridApi') private gridApi: GridApi;

    private logger: Logger;

    @PostConstruct
    private init(): void {
        this.logger = this.loggerFactory.create('ClipboardService');
    }

    public pasteFromClipboard(): void {
        this.logger.log('pasteFromClipboard');

        this.executeOnTempElement(
            (textArea: HTMLTextAreaElement)=> {
                textArea.focus();
            },
            (element: HTMLTextAreaElement)=> {
                let data = element.value;
                if (Utils.missingOrEmpty(data)) return;
                this.rangeController.isMoreThanOneCell() ? this.pasteToRange(data) : this.pasteToSingleCell(data);
            }
        );
    }

    private pasteToRange(data: string) {
        let clipboardData: any[][] = this.dataToArray(data);

        // remove extra empty row which is inserted when clipboard has more than one row
        if (clipboardData.length > 1) clipboardData.pop();

        let cellsToFlash = <any>{};
        let updatedRowNodes: RowNode[] = [];
        let updatedColumnIds: string[] = [];

        // true if clipboard data can be evenly pasted into range, otherwise false
        let abortRepeatingPasteIntoRows = this.rangeSize() % clipboardData.length != 0;

        let indexOffset = 0, dataRowIndex = 0;
        let rowCallback = (currentRow: GridRow, rowNode: RowNode, columns: Column[], index: number) => {

            let atEndOfClipboardData = index - indexOffset >= clipboardData.length;
            if (atEndOfClipboardData) {
                if(abortRepeatingPasteIntoRows) return;
                // increment offset and reset data index to repeat paste of data
                indexOffset += dataRowIndex;
                dataRowIndex = 0;
            }

            let currentRowData = clipboardData[index - indexOffset];

            // otherwise we are not the first row, so copy
            updatedRowNodes.push(rowNode);
            columns.forEach( (column: Column, index: number) => {
                if (!column.isCellEditable(rowNode)) return;

                // ignore columns we don't have data for - happens when to range is bigger than copied data range
                if (index >= currentRowData.length) return;

                let firstRowValue = currentRowData[index];
                let processCellFromClipboardFunc = this.gridOptionsWrapper.getProcessCellFromClipboardFunc();
                firstRowValue = this.userProcessCell(rowNode, column, firstRowValue, processCellFromClipboardFunc, Constants.EXPORT_TYPE_DRAG_COPY);
                this.valueService.setValue(rowNode, column, firstRowValue);

                let gridCellDef = <GridCellDef> {rowIndex: currentRow.rowIndex, floating: currentRow.floating, column: column};
                let cellId = new GridCell(gridCellDef).createId();
                cellsToFlash[cellId] = true;
            });

            ++dataRowIndex;
        };

        this.iterateActiveRanges(false, rowCallback);
        this.rowRenderer.refreshCells({rowNodes: updatedRowNodes, columns: updatedColumnIds});
        this.dispatchFlashCells(cellsToFlash);
    }

    private pasteToSingleCell(data: string) {
        if (Utils.missingOrEmpty(data)) { return; }

        let focusedCell = this.focusedCellController.getFocusedCell();
        if (!focusedCell) { return; }

        let parsedData: string[][] = this.dataToArray(data);
        if (!parsedData) {
            return;
        }

        // remove last row if empty, excel puts empty last row in
        let lastLine = parsedData[parsedData.length - 1];
        if (lastLine.length===1 && lastLine[0]==='') {
            Utils.removeFromArray(parsedData, lastLine);
        }

        let currentRow = new GridRow(focusedCell.rowIndex, focusedCell.floating);
        let cellsToFlash = <any>{};

        let updatedRowNodes: RowNode[] = [];
        let updatedColumnIds: string[] = [];

        let columnsToPasteInto = this.columnController.getDisplayedColumnsStartingAt(focusedCell.column);

        let onlyOneCellInRange = parsedData.length === 1 && parsedData[0].length === 1;
        if (onlyOneCellInRange) {
            this.singleCellRange(parsedData, updatedRowNodes, currentRow, cellsToFlash, updatedColumnIds);
        } else {
            this.multipleCellRange(parsedData, currentRow, updatedRowNodes, columnsToPasteInto, cellsToFlash, updatedColumnIds, Constants.EXPORT_TYPE_CLIPBOARD);
        }

        // this is very heavy, should possibly just refresh the specific cells?
        this.rowRenderer.refreshCells({rowNodes: updatedRowNodes, columns: updatedColumnIds});

        this.dispatchFlashCells(cellsToFlash);

        this.focusedCellController.setFocusedCell(focusedCell.rowIndex, focusedCell.column, focusedCell.floating, true);
    }

    public copyRangeDown(): void {
        if (this.rangeController.isEmpty()) { return; }

        let cellsToFlash = <any>{};
        let firstRowValues: any[] = null;

        let updatedRowNodes: RowNode[] = [];
        let updatedColumnIds: string[] = [];

        let rowCallback = (currentRow: GridRow, rowNode: RowNode, columns: Column[]) => {
            // take reference of first row, this is the one we will be using to copy from
            if (!firstRowValues) {
                firstRowValues = [];
                // two reasons for looping through columns
                columns.forEach( column => {
                    // reason 1 - to get the initial values to copy down
                    let value = this.valueService.getValue(column, rowNode);
                    let processCellForClipboardFunc = this.gridOptionsWrapper.getProcessCellForClipboardFunc();
                    value = this.userProcessCell(rowNode, column, value, processCellForClipboardFunc, Constants.EXPORT_TYPE_DRAG_COPY);
                    firstRowValues.push(value);
                    // reason 2 - to record the columnId for refreshing
                    updatedColumnIds.push(column.getId());
                });
            } else {
                // otherwise we are not the first row, so copy
                updatedRowNodes.push(rowNode);
                columns.forEach( (column: Column, index: number) => {
                    if (!column.isCellEditable(rowNode)) { return; }

                    let firstRowValue = firstRowValues[index];
                    let processCellFromClipboardFunc = this.gridOptionsWrapper.getProcessCellFromClipboardFunc();
                    firstRowValue = this.userProcessCell(rowNode, column, firstRowValue, processCellFromClipboardFunc, Constants.EXPORT_TYPE_DRAG_COPY);
                    this.valueService.setValue(rowNode, column, firstRowValue);

                    let gridCellDef = <GridCellDef> {rowIndex: currentRow.rowIndex, floating: currentRow.floating, column: column};
                    let cellId = new GridCell(gridCellDef).createId();
                    cellsToFlash[cellId] = true;
                });
            }
        };

        this.iterateActiveRanges(true, rowCallback);

        // this is very heavy, should possibly just refresh the specific cells?
        this.rowRenderer.refreshCells({rowNodes: updatedRowNodes, columns: updatedColumnIds});

        this.dispatchFlashCells(cellsToFlash);
    }

    private multipleCellRange(clipboardGridData: string[][], currentRow: GridRow, updatedRowNodes: RowNode[], columnsToPasteInto: Column[], cellsToFlash: any, updatedColumnIds: string[], type: string) {
        clipboardGridData.forEach((clipboardRowData: string[]) => {
            // if we have come to end of rows in grid, then skip
            if (!currentRow) {
                return;
            }

            let rowNode = this.getRowNode(currentRow);
            updatedRowNodes.push(rowNode);

            clipboardRowData.forEach((value: any, index: number)=> {
                let column = columnsToPasteInto[index];

                if (Utils.missing(column)) {
                    return;
                }
                if (!column.isCellEditable(rowNode)) {
                    return;
                }

                this.updateCellValue(rowNode, column, value, currentRow, cellsToFlash, updatedColumnIds, type);
            });
            // move to next row down for next set of values
            currentRow = this.cellNavigationService.getRowBelow(currentRow);
        });
        return currentRow;
    }

    private singleCellRange(parsedData: string[][], updatedRowNodes: RowNode[], currentRow: GridRow, cellsToFlash: any, updatedColumnIds: string[]) {
        let value = parsedData[0][0];
        let rowCallback = (gridRow: GridRow, rowNode: RowNode, columns: Column[]) => {
            updatedRowNodes.push(rowNode);
            columns.forEach((column) => {
                if (column.isCellEditable(rowNode)) {
                    this.updateCellValue(rowNode, column, value, currentRow, cellsToFlash, updatedColumnIds, Constants.EXPORT_TYPE_CLIPBOARD);
                }
            })
        };
        this.iterateActiveRanges(false, rowCallback);
    }

    private updateCellValue(rowNode: RowNode, column:Column, value: string, currentRow: GridRow, cellsToFlash: any, updatedColumnIds: string[], type: string) {
        if (column.isSuppressPaste(rowNode)) { return; }

        let processedValue = this.userProcessCell(rowNode, column, value, this.gridOptionsWrapper.getProcessCellFromClipboardFunc(), type);
        this.valueService.setValue(rowNode, column, processedValue);

        let gridCellDef = <GridCellDef> {
            rowIndex: currentRow.rowIndex,
            floating: currentRow.floating,
            column: column
        };
        let cellId = new GridCell(gridCellDef).createId();
        cellsToFlash[cellId] = true;

        if (updatedColumnIds.indexOf(column.getId()) < 0) {
            updatedColumnIds.push(column.getId());
        }
    }

    public copyToClipboard(includeHeaders = false): void {
        this.logger.log(`copyToClipboard: includeHeaders = ${includeHeaders}`);

        let selectedRowsToCopy = !this.selectionController.isEmpty()
            && !this.gridOptionsWrapper.isSuppressCopyRowsToClipboard();

        // default is copy range if exists, otherwise rows
        if (this.rangeController.isMoreThanOneCell()) {
            this.copySelectedRangeToClipboard(includeHeaders);
        } else if (selectedRowsToCopy) {
            // otherwise copy selected rows if they exist
            this.copySelectedRowsToClipboard(includeHeaders);
        } else if (this.focusedCellController.isAnyCellFocused()) {
            // if there is a focused cell, copy this
            this.copyFocusedCellToClipboard(includeHeaders);
        } else {
            // lastly if no focused cell, try range again. this can happen
            // if use has cellSelection turned off (so no focused cell)
            // but has a cell clicked, so there exists a cell range
            // of exactly one cell (hence the first 'if' above didn't
            // get executed).
            this.copySelectedRangeToClipboard(includeHeaders);
        }
    }

    private iterateActiveRanges(onlyFirst: boolean, rowCallback: RowCallback, columnCallback?: ColumnCallback): void {
        if (this.rangeController.isEmpty()) { return; }

        let rangeSelections = this.rangeController.getCellRanges();

        if (onlyFirst) {
            let range = rangeSelections[0];
            this.iterateActiveRange(range, rowCallback, columnCallback);
        } else {
            rangeSelections.forEach( range => this.iterateActiveRange(range, rowCallback, columnCallback) );
        }
    }

    private iterateActiveRange(range: RangeSelection, rowCallback: RowCallback, columnCallback?: ColumnCallback): void {
        // get starting and ending row, remember rowEnd could be before rowStart
        let startRow = range.start.getGridRow();
        let endRow = range.end.getGridRow();

        let startRowIsFirst = startRow.before(endRow);

        let currentRow = startRowIsFirst ? startRow : endRow;
        let lastRow = startRowIsFirst ? endRow : startRow;

        if (Utils.exists(columnCallback)) {
            columnCallback(range.columns);
        }

        let rangeIndex = 0;
        while (true) {

            let rowNode = this.getRowNode(currentRow);
            rowCallback(currentRow, rowNode, range.columns, rangeIndex++);

            if (currentRow.equals(lastRow)) {
                break;
            }

            currentRow = this.cellNavigationService.getRowBelow(currentRow);
        }
    }

    public copySelectedRangeToClipboard(includeHeaders = false): void {
        if (this.rangeController.isEmpty()) { return; }

        let deliminator = this.gridOptionsWrapper.getClipboardDeliminator();

        let data = '';
        let cellsToFlash = <any>{};

        /* added by ADP-e */ 
        const dataObj = <any>{
            colDefs: [],
            headings: [],
            rows:[]
        };

        // adds columns to the data
        let columnCallback = (columns: Column[]) => {
            if (!includeHeaders) { return; }

            columns.forEach( (column, index) => {
                let value = this.columnController.getDisplayNameForColumn(column, 'clipboard', true);
                if (index != 0) {
                    data += deliminator;
                }
                if (Utils.exists(value)) {
                    dataObj.headings.push(value);
                    data += value;
                } else {
                    dataObj.headings.push('');
                }
            });

            data += '\r\n';
        };

        // adds cell values to the data
        let rowCallback = (currentRow: GridRow, rowNode: RowNode, columns: Column[]) => {
            const row = <any>[]; // added by ADP-e
            columns.forEach( (column, index) => {
                let value = this.valueService.getValue(column, rowNode);

                let processedValue = this.userProcessCell(rowNode, column, value, this.gridOptionsWrapper.getProcessCellForClipboardFunc(), Constants.EXPORT_TYPE_CLIPBOARD);

                if (index != 0) {
                    data += deliminator;
                }

                if (dataObj.rows.length === 0) {
                    dataObj.colDefs.push(column);
                }

                if (Utils.exists(processedValue)) {
                    row.push(processedValue);
                    data += processedValue;
                } else {
                    row.push('');
                }
                let gridCellDef = <GridCellDef> {rowIndex: currentRow.rowIndex, floating: currentRow.floating, column: column};
                let cellId = new GridCell(gridCellDef).createId();
                cellsToFlash[cellId] = true;
            });

            dataObj.rows.push(row);
            data += '\r\n';
        };

        this.iterateActiveRanges(false, rowCallback, columnCallback);
        this.copyDataToClipboard(data, dataObj);
        this.dispatchFlashCells(cellsToFlash);
    }

    private copyFocusedCellToClipboard(includeHeaders = false): void {
        let focusedCell = this.focusedCellController.getFocusedCell();
        if (Utils.missing(focusedCell)) { return; }

        let currentRow = focusedCell.getGridRow();
        let rowNode = this.getRowNode(currentRow);
        let column = focusedCell.column;
        let value = this.valueService.getValue(column, rowNode);

        /* added by ADP-e */
        const dataObj = <any>{
            colDefs: [],
            headings: [],
            rows:[]
        };

        dataObj.colDefs.push(column.getColDef());

        let processedValue = this.userProcessCell(rowNode, column, value, this.gridOptionsWrapper.getProcessCellForClipboardFunc(), Constants.EXPORT_TYPE_CLIPBOARD);

        if (_.missing(processedValue)) {
            // copy the new line character to clipboard instead of an empty string, as the 'execCommand' will ignore it.
            // this behaviour is consistent with how Excel works!
            processedValue = '\n';
        }

        let data = '';
        if (includeHeaders) {
            let heading = this.columnController.getDisplayNameForColumn(column, 'clipboard', true); // added by ADP-e
            data = heading + '\r\n'; // changed by ADP-e
            dataObj.headings.push(heading); // added by ADP-e
        }
        data += processedValue.toString();
        dataObj.rows.push([data]); // added by ADP-e

        this.copyDataToClipboard(data, dataObj);

        let cellId = focusedCell.createId();
        let cellsToFlash = {};
        (<any>cellsToFlash)[cellId] = true;
        this.dispatchFlashCells(cellsToFlash);
    }

    private dispatchFlashCells(cellsToFlash: {}): void {
        setTimeout( ()=> {
            let event: FlashCellsEvent = {
                type: Events.EVENT_FLASH_CELLS,
                cells: cellsToFlash,
                api: this.gridApi,
                columnApi: this.columnApi
            };
            this.eventService.dispatchEvent(event);
        }, 0);
    }

    private userProcessCell(rowNode: RowNode, column: Column, value: any, func: (params: ProcessCellForExportParams) => void, type: string ): any {
        if (func) {
            let params = {
                column: column,
                node: rowNode,
                value: value,
                api: this.gridOptionsWrapper.getApi(),
                columnApi: this.gridOptionsWrapper.getColumnApi(),
                context: this.gridOptionsWrapper.getContext(),
                type: type
            };
            return func(params);
        } else {
            return value;
        }
    }

    private getRowNode(gridRow: GridRow): RowNode {
        switch (gridRow.floating) {
            case Constants.PINNED_TOP:
                return this.pinnedRowModel.getPinnedTopRowData()[gridRow.rowIndex];
            case Constants.PINNED_BOTTOM:
                return this.pinnedRowModel.getPinnedBottomRowData()[gridRow.rowIndex];
            default:
                return this.rowModel.getRow(gridRow.rowIndex);
        }
    }

    public copySelectedRowsToClipboard(includeHeaders = false, columnKeys?: (string|Column)[]): void {

        let skipHeader = !includeHeaders;
        let deliminator = this.gridOptionsWrapper.getClipboardDeliminator();

        let params: CsvExportParams = {
            columnKeys: columnKeys,
            skipHeader: skipHeader,
            skipFooters: true,
            suppressQuotes: true,
            columnSeparator: deliminator,
            onlySelected: true,
            processCellCallback: this.gridOptionsWrapper.getProcessCellForClipboardFunc()
        };

        let data = this.csvCreator.getDataAsCsv(params);

        this.copyDataToClipboard(data);
    }

    private htmlFormatter(dataObj?: any): string {
        const table = document.createElement('table');
        const thead = table.createTHead();
        const tbody = table.createTBody();
        const borderStyle = 'solid 1px #a9a9a9';
        const fontStyle = 'Helvetica Neue, Helvetica, Arial, sans-serif';

        const numericTypes = [
            'currency',
            'integer',
            'double',
        ];

        table.cellSpacing = '0';
        table.style.borderCollapse = 'collapse';

        if (dataObj.headings.length > 0) {
            const tr = thead.insertRow(0);
            dataObj.headings.forEach((heading: string, index: number) => {
                const td = tr.insertCell(index);
                td.innerText = heading;
                td.style.color = '#666';
                td.style.backgroundColor = '#eee';
                td.style.padding = '4px 8px';
                td.style.fontWeight = 'bold';
                td.style.fontFamily = fontStyle;
                td.style.fontSize = '11px';
                td.style.border = borderStyle;

                const dataType = dataObj.colDefs[index].getDefinition().dataType;
                if (numericTypes.indexOf(dataType) >= 0) {
                    td.style.textAlign = 'right';
                } else {
                    td.style.textAlign = 'center';
                }
            });
        }

        dataObj.rows.forEach((row: any, rowIndex: number) => {
            const tr = tbody.insertRow(rowIndex);

            row.forEach((cellValue: any, cellIndex: number) => {
                const td = tr.insertCell(cellIndex);
                td.innerText = cellValue;
                td.style.color = '#666';
                td.style.padding = '4px 8px';
                td.style.fontFamily = fontStyle;
                td.style.fontSize = '11px';
                td.style.border = borderStyle;

                const dataType = dataObj.colDefs[cellIndex].getDefinition().dataType;
                if (numericTypes.indexOf(dataType) >= 0) {
                    td.style.textAlign = 'right';
                } else {
                    td.style.textAlign = 'left';
                }
            });
        });

        return new XMLSerializer().serializeToString(table);
    }

    private copyDataToClipboard(data: string, dataObj?: any): void {
        let userProvidedFunc = this.gridOptionsWrapper.getSendToClipboardFunc();
        if (Utils.exists(userProvidedFunc)) {
            let params = {data: data};
            userProvidedFunc(params);
        } else {
            this.executeOnTempElement( (element: HTMLTextAreaElement)=> {
                element.value = data;
                element.select();
                element.focus();

                element.addEventListener('copy', (event) => {
                    if (data) {
                        event.clipboardData.setData('text/plain', data);
                    } else {
                        event.clipboardData.clearData('text/plain');
                    }

                    /* added by ADP-e */
                    const hasMoreThanOneCell = dataObj && (
                        dataObj.headings.length > 0 ||
                        dataObj.rows.length > 1 ||
                        (dataObj.rows.length > 0 && dataObj.rows[0].length > 1));

                    if (hasMoreThanOneCell) {
                        event.clipboardData.setData('text/html', this.htmlFormatter(dataObj));
                    } else {
                        event.clipboardData.clearData('text/html');
                    }

                    event.preventDefault();
                });

                return document.execCommand('copy');
            });
        }
    }

    private executeOnTempElement(
        callbackNow: (element: HTMLTextAreaElement)=>void,
        callbackAfter?: (element: HTMLTextAreaElement)=>void): void {

        let eTempInput = <HTMLTextAreaElement> document.createElement('textarea');
        eTempInput.style.width = '1px';
        eTempInput.style.height = '1px';
        eTempInput.style.top = '0px';
        eTempInput.style.left = '0px';
        eTempInput.style.position = 'absolute';
        eTempInput.style.opacity = '0.0';

        let guiRoot = this.gridCore.getRootGui();

        guiRoot.appendChild(eTempInput);

        try {
            let result = callbackNow(eTempInput);
            this.logger.log('Clipboard operation result: ' + result);
        } catch (err) {
            this.logger.log('Browser doesn\t support document.execComment(\'copy\') for clipboard operations');
        }

        //It needs 100 otherwise OS X seemed to not always be able to paste... Go figure...
        if (callbackAfter) {
            setTimeout( ()=> {
                callbackAfter(eTempInput);
                guiRoot.removeChild(eTempInput);
            }, 100);
        } else {
            guiRoot.removeChild(eTempInput);
        }
    }

    // From http://stackoverflow.com/questions/1293147/javascript-code-to-parse-csv-data
    // This will parse a delimited string into an array of arrays.
    // Note: this code fixes an issue with the example posted on stack overflow where it doesn't correctly handle
    // empty values in the first cell.
    private dataToArray(strData: string): string[][] {
        let delimiter = this.gridOptionsWrapper.getClipboardDeliminator();

        // Create a regular expression to parse the CSV values.
        let objPattern = new RegExp(
            (
                // Delimiters.
                "(\\" + delimiter + "|\\r?\\n|\\r|^)" +
                // Quoted fields.
                "(?:\"([^\"]*(?:\"\"[^\"]*)*)\"|" +
                // Standard fields.
                "([^\"\\" + delimiter + "\\r\\n]*))"
            ),
            "gi"
        );

        // Create an array to hold our data. Give the array
        // a default empty first row.
        let arrData: string[][] = [[]];

        // Create an array to hold our individual pattern matching groups.
        let arrMatches: string[];

        // Required for handling edge case on first row copy
        let atFirstRow = true;

        // Keep looping over the regular expression matches
        // until we can no longer find a match.
        while (arrMatches = objPattern.exec( strData )) {

            // Get the delimiter that was found.
            let strMatchedDelimiter = arrMatches[ 1 ];

            // Handles case when first row is an empty cell, insert an empty string before delimiter
            if (atFirstRow && strMatchedDelimiter) {
                arrData[0].push("");
            }

            // Check to see if the given delimiter has a length
            // (is not the start of string) and if it matches
            // field delimiter. If id does not, then we know
            // that this delimiter is a row delimiter.
            if (strMatchedDelimiter.length && strMatchedDelimiter !== delimiter) {
                // Since we have reached a new row of data,
                // add an empty row to our data array.
                arrData.push( [] );
            }

            let strMatchedValue: string;

            // Now that we have our delimiter out of the way,
            // let's check to see which kind of value we
            // captured (quoted or unquoted).
            if (arrMatches[ 2 ]) {
                // We found a quoted value. When we capture
                // this value, unescaped any double quotes.
                strMatchedValue = arrMatches[ 2 ].replace(new RegExp( "\"\"", "g" ), "\"");
            } else {
                // We found a non-quoted value.
                strMatchedValue = arrMatches[ 3 ];
            }

            // Now that we have our value string, let's add
            // it to the data array.
            arrData[ arrData.length - 1 ].push(strMatchedValue);

            atFirstRow = false;
        }

        // Return the parsed data.
        return arrData;
    }

    private rangeSize() {
        let ranges = this.rangeController.getCellRanges();
        let [startRange, endRange] = [ranges[0].start.rowIndex, ranges[0].end.rowIndex];
        return (startRange > endRange ? startRange - endRange : endRange - startRange) + 1;
    }
}